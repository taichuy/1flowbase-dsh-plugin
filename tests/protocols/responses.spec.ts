import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import { FlowbaseLlmAdapter, type AdapterModel } from '../../src/adapter.js'
import { ResponsesTransport } from '../../src/protocols/responses-transport.js'
import { streamResponses, compactResponses } from '../../src/protocols/responses.js'
import { responsesChunks } from '../../src/protocols/responses-events.js'
import { hostModule } from '../compaction/host.js'
import { guardForeignCompactRoute } from '../../src/protocols/route-guard.js'
import { responsesInput } from '../../src/protocols/responses-request.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const finalOutput = [{ type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: 'Hello' }] }]
const done = (output = finalOutput) => ({ type: 'response.completed', response: { id: 'resp', output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
function options(sessionId = 's', provider = 'p'): GenerateOptions {
  return { provider, model: 'm', sessionId: sessionId as GenerateOptions['sessionId'], messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] as GenerateOptions['messages'] }
}
function route(baseUrl: string): AdapterModel {
  return { provider: 'p', applicationId: 'app', applicationName: 'App', name: 'm', description: '', baseUrl,
    applicationKey: 'key', wireModel: 'm', contextWindow: 128000, maxTokens: 4096, protocol: 'responses', remoteCompaction: true }
}
async function collect(stream: AsyncIterable<StreamChunk>) { const result: StreamChunk[] = []; for await (const chunk of stream) result.push(chunk); return result }
async function fixture(mode: 'success' | 'network' | 'auth' | 'midstream' = 'success') {
  const requests: { path: string; body: any; authorization?: string }[] = []
  let upgrades = 0
  let failUntil = mode === 'network' ? Infinity : 0
  let compactStatus = 200
  const compactOutput = [{ type: 'compaction', encrypted_content: 'opaque-server-payload', id: 'cmp' }]
  let compactResponse: unknown = compactOutput
  const server = createServer(async (req, res) => {
    const bytes: Buffer[] = []; for await (const chunk of req) bytes.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(bytes).toString())
    requests.push({ path: req.url!, body, authorization: req.headers.authorization })
    if (req.url === '/v1/responses/compact') {
      res.writeHead(compactStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify(compactStatus === 200 ? { output: compactResponse } : { error: { message: 'cannot compact' } })); return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(done())}\n\n`)
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    upgrades++
    if (upgrades <= failUntil) { socket.destroy(); return }
    if (mode === 'auth') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', bytes => {
        requests.push({ path: 'WS', body: JSON.parse(bytes.toString()), authorization: req.headers.authorization })
        ws.send(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello' }))
        if (mode === 'midstream') ws.close()
        else ws.send(JSON.stringify(done()))
      })
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address')
  const transport = new ResponsesTransport({ connectTimeoutMs: 250, idleTimeoutMs: 1000, retryDelayMs: 0 })
  cleanup.push(async () => { transport.dispose(); for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { entry: route(`http://127.0.0.1:${address.port}`), transport, requests, compactOutput,
    compactResponse: (output: unknown) => { compactResponse = output },
    closeSockets: async () => {
      const closed = [...wss.clients].map(socket => once(socket, 'close'))
      for (const socket of wss.clients) socket.terminate()
      await Promise.all(closed)
      await new Promise(resolve => setTimeout(resolve, 10))
    },
    upgrades: () => upgrades, failUntil: (n: number) => { failUntil = n }, compactStatus: (n: number) => { compactStatus = n } }
}

describe('Responses transport and replay', () => {
  it('streams reasoning and tool arguments and refuses truncated event streams', async () => {
    const item = { type: 'function_call', id: 'fc', call_id: 'call', name: 'lookup', arguments: '{"q":"x"}' }
    async function* events() {
      yield { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }
      yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' }
      yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"x"}' }
      yield { type: 'response.output_item.done', output_index: 0, item }
      yield { type: 'response.reasoning_summary_text.delta', output_index: 1, summary_index: 0, delta: 'Think' }
      yield { type: 'response.completed', response: { output: [item, { type: 'reasoning', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'Think' }] }] } }
    }
    const chunks = await collect(responsesChunks(events()))
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call', name: 'lookup', arguments: '{"q":"x"}' } })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 1, text: 'Think' })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
    async function* truncated() { yield { type: 'response.output_text.delta', delta: 'partial' } }
    await expect(collect(responsesChunks(truncated()))).rejects.toThrow('terminal event')
  })

  it('prefers authenticated WebSocket and preserves selected effort and terminal native output', async () => {
    const f = await fixture()
    const chunks = await collect(streamResponses(f.transport, f.entry, { ...options(), reasoningEffort: 'custom-v2' as never }))
    expect(f.upgrades()).toBe(1)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ path: 'WS', authorization: 'Bearer key', body: { type: 'response.create', reasoning: { effort: 'custom-v2' } } })
    expect(f.requests[0]!.body).not.toHaveProperty('stream')
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'Hello' }])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { output: finalOutput } } })
  })
  it('falls back after exactly five connection failures and retains SSE per session/provider', async () => {
    const f = await fixture('network')
    await collect(streamResponses(f.transport, f.entry, options()))
    expect(f.upgrades()).toBe(5)
    expect(f.requests[0]?.path).toBe('/v1/responses')
    await collect(streamResponses(f.transport, f.entry, options()))
    expect(f.upgrades()).toBe(5)
    f.failUntil(5)
    await collect(streamResponses(f.transport, f.entry, options('other')))
    expect(f.upgrades()).toBe(6)
    await collect(streamResponses(f.transport, { ...f.entry, provider: 'other' }, options('s', 'other')))
    expect(f.upgrades()).toBe(7)
  })
  it('shares cumulative connection failures across concurrent calls without losing increments', async () => {
    const f = await fixture('network')
    await Promise.all(Array.from({ length: 3 }, () => collect(streamResponses(f.transport, f.entry, options()))))
    // Up to two attempts may already be in flight when the fifth failure consumes the budget.
    expect(f.upgrades()).toBeGreaterThanOrEqual(5)
    expect(f.upgrades()).toBeLessThanOrEqual(7)
    const attempts = f.upgrades()
    expect(f.requests.filter(request => request.path === '/v1/responses')).toHaveLength(3)
    await collect(streamResponses(f.transport, f.entry, options()))
    expect(f.upgrades()).toBe(attempts)
    expect(f.requests.filter(request => request.path === '/v1/responses')).toHaveLength(4)
  })
  it('does not reset cumulative failures after a successful connection', async () => {
    const f = await fixture()
    f.failUntil(4)
    await collect(streamResponses(f.transport, f.entry, options()))
    expect(f.upgrades()).toBe(5)
    await f.closeSockets()
    f.failUntil(Infinity)
    await collect(streamResponses(f.transport, f.entry, options()))
    expect(f.upgrades()).toBe(6)
    expect(f.requests.at(-1)?.path).toBe('/v1/responses')
  })
  it.each(['auth', 'midstream'] as const)('never replays %s failures as connection retries', async mode => {
    const f = await fixture(mode)
    await expect(collect(streamResponses(f.transport, f.entry, options()))).rejects.toThrow()
    expect(f.upgrades()).toBe(1)
    expect(f.requests.filter(req => req.path === '/v1/responses')).toHaveLength(0)
  })
  it('honors cancellation without spending a connection attempt', async () => {
    const f = await fixture()
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(collect(streamResponses(f.transport, f.entry, { ...options(), signal: controller.signal }))).rejects.toThrow('cancelled')
    expect(f.upgrades()).toBe(0)
  })
  it('retains native compaction output for next input and rejects route switches', async () => {
    const f = await fixture()
    const result = await compactResponses(f.entry, options())
    expect(f.requests[0]).toMatchObject({ path: '/v1/responses/compact', body: { model: 'm', input: [{ role: 'user', content: 'Hi' }] } })
    const restored = JSON.parse(JSON.stringify(result.block))
    const next = { ...options(), messages: [{ role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'cmp' }, content: [
      { type: 'text', text: 'DSH framing must not reach provider' }, restored,
    ] }] } as GenerateOptions
    expect(responsesInput(next)).toEqual(f.compactOutput)
    expect(() => responsesInput({ ...next, model: 'different' })).toThrow('original application/model')
    f.compactResponse([...f.compactOutput, null])
    await expect(compactResponses(f.entry, options())).rejects.toThrow('native encrypted compaction item')
    f.compactStatus(500)
    await expect(compactResponses(f.entry, options())).rejects.toThrow('cannot compact')
  })
  it('keeps host prepared calls frozen while rejecting new incompatible checkpoint calls', async () => {
    const f = await fixture()
    const { Context } = await hostModule('@deepseek-ai/cordis')
    const { LlmRuntime } = await hostModule('@deepseek-ai/dsh-llm')
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    let entry = f.entry
    const adapter = new FlowbaseLlmAdapter(() => ({ providers: new Map([['p', { name: 'App', models: new Map([['m', entry]]) }]]) }))
    llm.registerAdapter(['p'], adapter)
    ctx.on('llm/stream', (request: GenerateOptions, next: () => unknown) => {
      guardForeignCompactRoute(request, request.provider === 'p' && request.model === 'm')
      return next()
    })
    const request = { ...options(), messages: [{ role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'c' }, content: [{
      type: 'flowbase-responses-compaction', version: 1, provider: 'p', model: 'm',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }] }] } as GenerateOptions
    try {
      const prepared = await llm.prepareCall({ provider: 'p', model: 'm' })
      entry = { ...entry, protocol: 'chat-completions', applicationKey: 'changed' }
      await collect(prepared.stream({ ...prepared.config, ...request }))
      expect(f.requests[0]).toMatchObject({ path: 'WS', authorization: 'Bearer key' })
      const changed = await llm.prepareCall({ provider: 'p', model: 'm' })
      const refused = await collect(changed.stream({ ...changed.config, ...request }))
      expect(refused).toEqual([{ type: 'finish', reason: { kind: 'error', failure: expect.objectContaining({
        message: expect.stringContaining('original application/model'),
      }) } }])
      expect(() => guardForeignCompactRoute({ ...request, provider: 'other' }, false)).toThrow('original application/model')
      expect(f.requests).toHaveLength(1)
    } finally { adapter.dispose(); await ctx.fiber.dispose() }
  })
  it('converts tool-call pairs and native reasoning replay without losing encrypted content', () => {
    const native = [{ type: 'reasoning', encrypted_content: 'secret', summary: [] }, { type: 'function_call', call_id: 'c', name: 'lookup', arguments: '{}' }]
    const request = { ...options(), messages: [
      { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm', replayState: { response: { format: 'flowbase-responses-v1', output: native } } }, content: [{ type: 'tool-call', id: 'c' as ToolCallId, name: 'lookup', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text: 'result' }] },
    ] } as GenerateOptions
    expect(responsesInput(request)).toEqual([...native, { type: 'function_call_output', call_id: 'c', output: 'result' }])
  })
})
