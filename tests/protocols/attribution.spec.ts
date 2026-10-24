import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { formatUserAgent, operatingSystemName, hostAttributionHeaders } from '../../src/attribution.js'
import { FlowbaseLlmAdapter, type AdapterModel } from '../../src/adapter.js'
import { streamResponses, compactResponses } from '../../src/protocols/responses.js'
import { ResponsesTransport } from '../../src/protocols/responses-transport.js'
import { streamAnthropic } from '../../src/protocols/anthropic.js'
async function drain(events: AsyncIterable<unknown>) { for await (const _ of events) { /* consume */ } }

describe('host request attribution', () => {
  it('uses real distribution data and keeps the host product/version and URL', () => {
    const system = operatingSystemName('Linux', '6.8.0', 'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="unused"')
    expect(formatUserAgent('deepseek-harness/1.2.3 (+https://example.test)', system, 'x64'))
      .toBe('deepseek-harness/1.2.3 (Ubuntu 24.04; x86_64) (+https://example.test)')
    expect(operatingSystemName('Linux', '6.8.0')).toBe('Linux 6.8.0')
    expect(formatUserAgent('deepseek-harness/1.2.3', 'Darwin 25.0', 'arm64'))
      .toBe('deepseek-harness/1.2.3 (Darwin 25.0; arm64)')
  })
  it('sends the same host identity over Chat, WS, SSE, compaction and Anthropic', async () => {
    const received: { path: string; ua: string | undefined }[] = []
    const done = { type: 'response.completed', response: { id: 'r', output: [], usage: { input_tokens: 1, output_tokens: 0 } } }
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* consume */ }
      const path = new URL(req.url!, 'http://localhost').pathname
      received.push({ path, ua: req.headers['user-agent'] })
      if (path === '/v1/responses') {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify(done)}\n\n`)
      } else if (path === '/v1/responses/compact') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output: [{ type: 'compaction', encrypted_content: 'opaque' }] }))
      } else if (path === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
      } else if (path === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of [
          { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
          { type: 'message_stop' },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        res.end()
      } else { res.writeHead(404); res.end() }
    })
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws, req) => {
      received.push({ path: 'WS', ua: req.headers['user-agent'] })
      ws.on('message', () => ws.send(JSON.stringify(done)))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const entry: AdapterModel = { provider: 'p', applicationId: 'a', applicationName: 'A', name: 'm', description: '', wireModel: 'm', baseUrl: `http://127.0.0.1:${address.port}`, applicationKey: 'mock', contextWindow: 10000, maxTokens: 1000, protocol: 'chat-completions' }
    const options: GenerateOptions = { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
    const adapter = new FlowbaseLlmAdapter(() => ({ providers: new Map([['p', { name: 'A', models: new Map([['m', entry]]) }]]) }))
    const transport = new ResponsesTransport({ connectTimeoutMs: 1000, idleTimeoutMs: 1000, retryDelayMs: 0 })
    try {
      await drain(adapter.stream(options))
      await drain(streamResponses(transport, entry, options))
      await drain(streamResponses(transport, entry, { ...options, purpose: 'compaction' }))
      await compactResponses(entry, options)
      await drain(streamAnthropic(entry, options))
      expect(received.map(row => row.path)).toEqual(['/v1/chat/completions', 'WS', '/v1/responses', '/v1/responses/compact', '/v1/messages'])
      const expected = hostAttributionHeaders()['user-agent']
      expect(expected).toMatch(/^deepseek-harness\/[^ ]+ \(.+; .+\)/u)
      expect(received.every(row => row.ua === expected)).toBe(true)
      expect(expected).not.toContain('Codex')
    } finally {
      adapter.dispose(); transport.dispose()
      for (const ws of wss.clients) ws.terminate()
      wss.close(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
