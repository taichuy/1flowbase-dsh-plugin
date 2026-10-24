import { createHash } from 'node:crypto'
import { responseHeaders } from './metadata.js'
import { continuation, continuationRejection, saveResponse, type ResponseSession } from './responses-session.js'
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
  private readonly sessions = new Map<string, ResponseSession>()
  private readonly unsupportedContinuations = new Set<string>()
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
    for (const session of this.sessions.values()) clearTimeout(session.idle)
    this.sessions.clear()
    this.failures.clear()
    this.unsupportedContinuations.clear()
  }

  async *events(entry: AdapterModel, options: GenerateOptions, body: JsonObject): AsyncGenerator<JsonObject> {
    if (this.disposed) throw new Error('Responses transport disposed')
    const key = options.sessionId === undefined ? undefined : JSON.stringify([options.sessionId, options.provider])
    let failures = key === undefined ? 0 : this.failures.get(key) ?? 0
    // Auxiliary title calls neither consume nor reset a conversation's WebSocket budget.
    if (options.purpose === undefined) {
      for (;;) {
        failures = key === undefined ? failures : this.failures.get(key) ?? 0
        if (failures >= CONNECTION_FAILURE_LIMIT) break
        options.signal?.throwIfAborted()
        try {
          yield* this.sessionEvents(entry, body, options)
          return
        } catch (error) {
          options.signal?.throwIfAborted()
          if (!(error instanceof ConnectionFailure)) throw error
          failures = Math.max(failures, key === undefined ? 0 : this.failures.get(key) ?? 0) + 1
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
        method: 'POST', headers: { ...responseHeaders(entry, options), 'content-type': 'application/json', accept: 'text/event-stream' },
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

  private closeSession(session: ResponseSession): void {
    clearTimeout(session.idle)
    if (session.socket) {
      this.sockets.delete(session.socket)
      session.socket.terminate()
      session.socket = undefined
    }
    session.previous = undefined
  }

  private async *sessionEvents(entry: AdapterModel, body: JsonObject, options: GenerateOptions): AsyncGenerator<JsonObject> {
    // No credential material is retained in cache keys; auxiliary/anonymous calls are never pooled.
    const routeKey = createHash('sha256').update(JSON.stringify([
      options.provider, options.model, entry.provider, entry.applicationId, entry.baseUrl, entry.wireModel, entry.applicationKey,
    ])).digest('hex')
    const key = options.sessionId === undefined ? undefined : createHash('sha256').update(JSON.stringify([options.sessionId, routeKey])).digest('hex')
    let session = key === undefined ? undefined : this.sessions.get(key)
    let pooled = session !== undefined && !session.busy
    if (session?.busy) session = undefined // Dedicated overflow connection; no interleaved response streams.
    if (!session) {
      session = { busy: false, continuationDisabled: false }
      if (key !== undefined && !this.sessions.has(key)) {
        if (this.sessions.size >= 32) {
          const victim = [...this.sessions].find(([, value]) => !value.busy)
          if (victim) { this.closeSession(victim[1]); this.sessions.delete(victim[0]) }
        }
        if (this.sessions.size < 32) { this.sessions.set(key, session); pooled = true }
      }
    }
    session.continuationDisabled ||= this.unsupportedContinuations.has(routeKey)
    session.busy = true
    clearTimeout(session.idle)
    // Canonical full request is immutable across delta projection and retries.
    const canonical = structuredClone(body)
    try {
      let request = continuation(canonical, session)
      session.previous = undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        let retry = false
        let inferenceStarted = false
        for await (const event of this.websocket(entry, request, options, session, canonical)) {
          const rejection = continuationRejection(event)
          if (attempt === 0 && request.previous_response_id !== undefined && !inferenceStarted && rejection) {
            if (rejection === 'unsupported') {
              session.continuationDisabled = true
              if (this.unsupportedContinuations.size >= 128) this.unsupportedContinuations.delete(this.unsupportedContinuations.values().next().value!)
              this.unsupportedContinuations.add(routeKey)
            }
            retry = true
            break
          }
          // Only lifecycle acknowledgements are safe before replay. Any other event is conservative evidence of output.
          if (!['response.created', 'response.queued', 'response.in_progress', 'error', 'response.failed'].includes(String(event.type))) inferenceStarted = true
          saveResponse(session, canonical, event)
          yield event
        }
        if (!retry) return
        this.closeSession(session)
        request = canonical
      }
    } finally {
      session.busy = false
      if (!pooled || this.disposed) this.closeSession(session)
      else {
        const released = session
        session.idle = setTimeout(() => {
          this.closeSession(released)
          if (key !== undefined && this.sessions.get(key) === released) this.sessions.delete(key)
        }, this.options.idleTimeoutMs)
        session.idle.unref()
      }
    }
  }

  private async *websocket(entry: AdapterModel, body: JsonObject, options: GenerateOptions, session: ResponseSession, canonical: JsonObject): AsyncGenerator<JsonObject> {
    const signal = options.signal
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('Responses transport disposed')
    if (session.socket && session.socket.readyState !== 1) this.closeSession(session)
    let socket = session.socket
    const reused = socket !== undefined
    let opened = reused
    if (!socket) {
      const module = await loadHostModule('ws') as { default: typeof WebSocket }
      signal?.throwIfAborted()
      if (this.disposed) throw new Error('Responses transport disposed')
      const url = new URL(`${entry.baseUrl}/v1/responses`)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new module.default(url, {
        headers: { ...responseHeaders(entry, options), 'OpenAI-Beta': 'responses_websockets=2026-02-06' },
        handshakeTimeout: this.options.connectTimeoutMs,
        perMessageDeflate: true,
      })
      session.socket = socket
      this.sockets.add(socket)
      // A reused idle connection can close/error between calls without an active reader.
      socket.on('error', () => undefined)
      socket.once('close', () => {
        this.sockets.delete(socket!)
        if (session.socket === socket) { session.socket = undefined; session.previous = undefined }
      })
    }
    const activeSocket = socket
    const queue: JsonObject[] = []
    let failure: Error | undefined
    let wake: (() => void) | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    let completed = false
    const fail = (error: Error): void => { failure ??= error; wake?.() }
    const abort = (): void => { fail(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted')); activeSocket.terminate() }
    const resetIdle = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => { fail(new FlowbaseError('STREAM_INTERRUPTED', 'Responses WebSocket idle timeout')); activeSocket.terminate() }, this.options.idleTimeoutMs)
    }
    const onMessage = (bytes: WebSocket.RawData): void => {
      try {
        const event: unknown = JSON.parse(bytes.toString())
        if (!object(event)) throw new Error('Invalid Responses WebSocket event')
        queue.push(event); resetIdle(); wake?.()
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    }
    const onError = (error: Error): void => fail(opened ? new FlowbaseError('STREAM_INTERRUPTED', error.message) : new ConnectionFailure(error.message))
    const onClose = (): void => fail(opened ? new FlowbaseError('STREAM_INTERRUPTED', 'Responses WebSocket closed before completion') : new ConnectionFailure('WebSocket closed before connection'))
    const onRejected = (_request: unknown, response: IncomingMessage): void => {
      fail(httpError(response.statusCode ?? 502, `WebSocket handshake rejected: HTTP ${String(response.statusCode)}`))
      response.resume()
      activeSocket.terminate()
    }
    const onOpen = (): void => { opened = true; resetIdle(); wake?.() }
    activeSocket.on('message', onMessage)
    activeSocket.on('error', onError)
    activeSocket.on('close', onClose)
    activeSocket.on('unexpected-response', onRejected)
    activeSocket.on('open', onOpen)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      while (!opened) {
        if (failure) throw failure
        await new Promise<void>(resolve => { wake = resolve })
      }
      signal?.throwIfAborted()
      resetIdle()
      const { stream: _stream, ...request } = reused ? body : canonical
      activeSocket.send(JSON.stringify({ type: 'response.create', ...request }))
      for (;;) {
        const event = queue.shift()
        if (event !== undefined) {
          if (event.type === 'response.completed') completed = true
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
      activeSocket.off('message', onMessage)
      activeSocket.off('error', onError)
      activeSocket.off('close', onClose)
      activeSocket.off('unexpected-response', onRejected)
      activeSocket.off('open', onOpen)
      if (!completed || signal?.aborted || this.disposed) this.closeSession(session)
    }
  }
}
