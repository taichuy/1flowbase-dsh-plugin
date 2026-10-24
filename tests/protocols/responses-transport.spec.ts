import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../../src/adapter.js'
import { ResponsesTransport } from '../../src/protocols/responses-transport.js'
import type { JsonObject } from '../../src/protocols/responses-request.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const output = [{ type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }]
const initial = [{ role: 'user', content: 'first' }]
const added = { role: 'user', content: 'next' }
const body = (input: unknown[] = initial): JsonObject => ({ model: 'm', input, stream: true, store: false })
const opts = (sessionId = 's'): GenerateOptions => ({ sessionId, provider: 'p', model: 'm', messages: [] }) as unknown as GenerateOptions
const complete = (ws: WebSocket) => ws.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp', output } }))
async function collect(events: AsyncIterable<JsonObject>) { const out: JsonObject[] = []; for await (const event of events) out.push(event); return out }
async function fixture(handler: (ws: WebSocket, body: JsonObject, count: number) => void = ws => complete(ws), idleTimeoutMs = 1000) {
  const requests: JsonObject[] = []
  const extensions: string[] = []
  let upgrades = 0
  const server = createServer((_req, res) => { res.writeHead(500); res.end() })
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
  server.on('upgrade', (req, socket, head) => {
    upgrades++
    wss.handleUpgrade(req, socket, head, ws => {
      extensions.push(ws.extensions)
      ws.on('message', bytes => {
        const value = JSON.parse(bytes.toString()) as JsonObject
        requests.push(value)
        handler(ws, value, requests.length)
      })
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
  const entry: AdapterModel = { provider: 'p', applicationId: 'a', applicationName: 'A', name: 'm', wireModel: 'm', description: '',
    baseUrl: `http://127.0.0.1:${address.port}`, applicationKey: 'key', contextWindow: 10000, maxTokens: 1000, protocol: 'responses', remoteCompaction: true }
  const transport = new ResponsesTransport({ connectTimeoutMs: 200, idleTimeoutMs, retryDelayMs: 0 })
  cleanups.push(async () => { transport.dispose(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { transport, entry, requests, extensions, upgrades: () => upgrades, clients: () => wss.clients.size,
    run: (request = body(), options = opts(), route = entry) => collect(transport.events(route, options, request)) }
}

describe('Responses reusable socket and continuation contract', () => {
  it('negotiates compression, reuses the socket and transmits only the exact next native items', async () => {
    const f = await fixture()
    await f.run()
    const full = body([...initial, ...output, added])
    await f.run(full)
    expect(f.extensions).toEqual(['permessage-deflate'])
    expect(f.upgrades()).toBe(1)
    expect(f.requests[1]).toMatchObject({ previous_response_id: 'resp', input: [added] })
    expect(full.input).toEqual([...initial, ...output, added])
  })

  it('never caches malformed successful native output for continuation', async () => {
    const f = await fixture((ws, _request, count) => {
      if (count === 1) ws.send(JSON.stringify({ type: 'response.completed', response: { id: 'bad', output: [null] } }))
      else complete(ws)
    })
    await f.run()
    await f.run(body([...initial, null, added]))
    expect(f.requests[1]).not.toHaveProperty('previous_response_id')
  })

  it.each(['history', 'compaction', 'setting'])('resets continuation when %s changes', async change => {
    const f = await fixture(); await f.run()
    const next = change === 'history' ? body([{ role: 'user', content: 'edited' }, ...output, added])
      : change === 'compaction' ? body([{ type: 'compaction', encrypted_content: 'opaque' }, added])
      : { ...body([...initial, ...output, added]), temperature: 0.2 }
    await f.run(next)
    expect(f.requests[1]).not.toHaveProperty('previous_response_id')
    expect(f.requests[1]?.input).toEqual(next.input)
  })

  it.each(['missing', 'unsupported'])('retries %s continuation once with canonical full input', async mode => {
    const f = await fixture((ws, request) => {
      if (request.previous_response_id) ws.send(JSON.stringify({ type: 'error', error: mode === 'missing'
        ? { code: 'previous_response_not_found' } : { code: 'unsupported_parameter', param: 'previous_response_id' } }))
      else complete(ws)
    })
    await f.run()
    const second = body([...initial, ...output, added])
    await f.run(second)
    expect(f.requests).toHaveLength(3)
    expect(f.requests[1]).toMatchObject({ previous_response_id: 'resp', input: [added] })
    expect(f.requests[2]).not.toHaveProperty('previous_response_id')
    expect(f.requests[2]?.input).toEqual(second.input)
    if (mode === 'unsupported') {
      await f.run(body([...(second.input as unknown[]), ...output, added]))
      expect(f.requests).toHaveLength(4)
      expect(f.requests[3]).not.toHaveProperty('previous_response_id')
      await f.run(body(), opts('new-session'))
      await f.run(second, opts('new-session'))
      expect(f.requests).toHaveLength(6)
      expect(f.requests[5]).not.toHaveProperty('previous_response_id')
    }
  })

  it.each(['auth', 'output', 'generic'])('does not replay %s errors', async mode => {
    const f = await fixture((ws, _request, count) => {
      if (count === 1) { complete(ws); return }
      if (mode === 'output') ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }))
      ws.send(JSON.stringify({ type: 'error', error: { code: mode === 'auth' ? 'invalid_api_key' : mode === 'generic' ? 'invalid_request_error' : 'previous_response_not_found' } }))
    })
    await f.run(); await f.run(body([...initial, ...output, added]))
    expect(f.requests).toHaveLength(2)
  })

  it('does not retry a full request rejected with a missing previous response', async () => {
    const f = await fixture(ws => ws.send(JSON.stringify({ type: 'error', error: { code: 'previous_response_not_found' } })))
    await f.run()
    expect(f.requests).toHaveLength(1)
  })

  it('does not replay cancellation during inference', async () => {
    let received!: () => void
    const ready = new Promise<void>(resolve => { received = resolve })
    const f = await fixture(() => received())
    const controller = new AbortController()
    const pending = f.run(body(), { ...opts(), signal: controller.signal })
    await ready; controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(f.requests).toHaveLength(1)
  })

  it('isolates concurrent streams on dedicated connections', async () => {
    const waiting: WebSocket[] = []
    const f = await fixture(ws => { waiting.push(ws); if (waiting.length === 2) waiting.forEach(complete) })
    const result = await Promise.all([f.run(), f.run()])
    expect(f.upgrades()).toBe(2)
    expect(result.map(events => events.length)).toEqual([1, 1])
    expect(f.requests.every(request => request.previous_response_id === undefined)).toBe(true)
  })

  it('isolates sessions, credentials, model and endpoint/provider routes', async () => {
    const f = await fixture()
    await f.run()
    await f.run(body(), opts('other'))
    await f.run(body(), opts(), { ...f.entry, applicationKey: 'rotated' })
    await f.run({ ...body(), model: 'other' }, opts(), { ...f.entry, wireModel: 'other' })
    await f.run(body(), { ...opts(), provider: 'other' })
    expect(f.upgrades()).toBe(5)
    expect(f.requests.every(request => request.previous_response_id === undefined)).toBe(true)
  })

  it('reconnects with full input after idle cleanup and closes all sockets on disposal', async () => {
    const f = await fixture(undefined, 40)
    await f.run()
    await delay(100)
    expect(f.clients()).toBe(0)
    await f.run(body([...initial, ...output, added]))
    expect(f.upgrades()).toBe(2)
    expect(f.requests[1]).not.toHaveProperty('previous_response_id')
    f.transport.dispose()
    await delay(20)
    expect(f.clients()).toBe(0)
    await expect(f.run()).rejects.toThrow('disposed')
  })

  it('bounds cached idle connections', async () => {
    const f = await fixture(undefined, 10000)
    for (let i = 0; i < 35; i++) await f.run(body(), opts(String(i)))
    await delay(20)
    expect(f.clients()).toBeLessThanOrEqual(32)
  })
})
