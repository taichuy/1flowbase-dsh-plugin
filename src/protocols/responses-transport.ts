import { setTimeout as delay } from 'node:timers/promises'
import type WebSocket from 'ws'
import type { IncomingMessage } from 'node:http'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../adapter.js'
import { FlowbaseError } from '../errors.js'
import { loadHostModule } from '../host-module.js'
import { object, type JsonObject } from './responses-request.js'

export interface ResponsesTransportOptions {
  connectTimeoutMs: number
  idleTimeoutMs: number
  retryDelayMs: number
}
const CONNECTION_FAILURE_LIMIT = 5
class ConnectionFailure extends Error {}

function httpError(status: number, message: string): FlowbaseError {
  return new FlowbaseError(status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST', message, status)
}

export async function responseJson(response: Response): Promise<JsonObject> {
  const text = await response.text()
  if (!response.ok) throw httpError(response.status, text)
  const data: unknown = JSON.parse(text)
  if (!object(data)) throw new Error('Expected a Responses JSON object')
  return data
}

/** Decode complete SSE records, including multiline data and split UTF-8 characters. */
async function* sse(response: Response): AsyncGenerator<JsonObject> {
  if (!response.ok) throw httpError(response.status, await response.text())
  if (response.body === null || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected Responses SSE stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let data: string[] = []
  const decode = (): JsonObject | undefined => {
    const value = data.join('\n'); data = []
    if (!value || value === '[DONE]') return undefined
    const parsed: unknown = JSON.parse(value)
    if (!object(parsed)) throw new Error('Invalid Responses event')
    return parsed
  }
  try {
    for (;;) {
      const chunk = await reader.read()
      pending += decoder.decode(chunk.value, { stream: !chunk.done })
      if (chunk.done) pending += '\n\n'
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/u, '')
        pending = pending.slice(end + 1)
        if (line === '') { const event = decode(); if (event) yield event }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
      }
      if (chunk.done) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Owner of transport fallback state; isolated by live session and provider, never by API key. */
export class ResponsesTransport {
  private readonly failures = new Map<string, number>()
  private readonly sockets = new Set<WebSocket>()
  private disposed = false
  constructor(private readonly options: ResponsesTransportOptions) {
    for (const [key, value] of Object.entries(options)) {
      if (!Number.isSafeInteger(value) || value < (key === 'retryDelayMs' ? 0 : 1)) throw new Error(`Invalid Responses transport option: ${key}`)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
    this.failures.clear()
  }

  async *events(entry: AdapterModel, options: GenerateOptions, body: JsonObject): AsyncGenerator<JsonObject> {
    if (this.disposed) throw new Error('Responses transport disposed')
    const key = options.sessionId === undefined ? undefined : JSON.stringify([options.sessionId, options.provider])
    let failures = key === undefined ? 0 : this.failures.get(key) ?? 0
    // Auxiliary title calls neither consume nor reset a conversation's WebSocket budget.
    if (options.purpose === undefined) {
      while (failures < CONNECTION_FAILURE_LIMIT) {
        options.signal?.throwIfAborted()
        try {
          yield* this.websocket(entry, body, options.signal)
          return
        } catch (error) {
          options.signal?.throwIfAborted()
          if (!(error instanceof ConnectionFailure)) throw error
          failures++
          if (key !== undefined) this.failures.set(key, failures)
          if (failures < CONNECTION_FAILURE_LIMIT) await delay(this.options.retryDelayMs * failures, undefined, { signal: options.signal })
        }
      }
    }
    const controller = new AbortController()
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    let timer = setTimeout(() => controller.abort(new Error('Responses stream idle timeout')), this.options.idleTimeoutMs)
    try {
      const response = await fetch(`${entry.baseUrl}/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${entry.applicationKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body), signal,
      })
      for await (const event of sse(response)) {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(new Error('Responses stream idle timeout')), this.options.idleTimeoutMs)
        yield event
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  private async *websocket(entry: AdapterModel, body: JsonObject, signal?: AbortSignal): AsyncGenerator<JsonObject> {
    const module = await loadHostModule('ws') as { default: typeof WebSocket }
    signal?.throwIfAborted()
    const url = new URL(`${entry.baseUrl}/v1/responses`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new module.default(url, {
      headers: { authorization: `Bearer ${entry.applicationKey}`, 'OpenAI-Beta': 'responses_websockets=2026-02-06' },
      handshakeTimeout: this.options.connectTimeoutMs,
    })
    this.sockets.add(socket)
    const queue: JsonObject[] = []
    let failure: Error | undefined
    let wake: (() => void) | undefined
    let opened = false
    let idle: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error): void => { failure ??= error; wake?.() }
    const abort = (): void => { fail(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted')); socket.terminate() }
    const resetIdle = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => { fail(new FlowbaseError('STREAM_INTERRUPTED', 'Responses WebSocket idle timeout')); socket.terminate() }, this.options.idleTimeoutMs)
    }
    socket.on('message', bytes => {
      try {
        const event: unknown = JSON.parse(bytes.toString())
        if (!object(event)) throw new Error('Invalid Responses WebSocket event')
        queue.push(event); resetIdle(); wake?.()
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
    socket.on('error', error => fail(opened ? new FlowbaseError('STREAM_INTERRUPTED', error.message) : new ConnectionFailure(error.message)))
    socket.on('close', () => fail(opened ? new FlowbaseError('STREAM_INTERRUPTED', 'Responses WebSocket closed before completion') : new ConnectionFailure('WebSocket closed before connection')))
    socket.on('unexpected-response', (_request, response: IncomingMessage) => {
      // Server rejection is not a connection failure; never retry credentials or bad protocol requests five times.
      fail(httpError(response.statusCode ?? 502, `WebSocket handshake rejected: HTTP ${String(response.statusCode)}`))
      response.resume()
      socket.terminate()
    })
    signal?.addEventListener('abort', abort, { once: true })
    const ready = new Promise<void>(resolve => socket.once('open', () => { opened = true; resetIdle(); resolve(); wake?.() }))
    // Never send response.create until the handshake is known to have succeeded.
    try {
      while (!opened) {
        if (failure) throw failure
        await Promise.race([ready, new Promise<void>(resolve => { wake = resolve })])
      }
      signal?.throwIfAborted()
      const { stream: _stream, ...request } = body
      socket.send(JSON.stringify({ type: 'response.create', ...request }))
      for (;;) {
        const event = queue.shift()
        if (event !== undefined) {
          yield event
          if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(String(event.type))) return
          continue
        }
        if (failure) throw failure
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      clearTimeout(idle)
      signal?.removeEventListener('abort', abort)
      this.sockets.delete(socket)
      socket.terminate()
    }
  }
}
