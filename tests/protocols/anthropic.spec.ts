import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../../src/adapter.js'
import { streamAnthropic } from '../../src/protocols/anthropic.js'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function endpoint(handler: (request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse) => void): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const buffers: Buffer[] = []
      for await (const chunk of request) buffers.push(Buffer.from(chunk as Uint8Array))
      handler(request, JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown>, response)
    })().catch(error => { response.writeHead(500); response.end(String(error)) })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No test port')
  return `http://127.0.0.1:${String(address.port)}`
}

function entry(baseUrl: string): AdapterModel {
  return { provider: 'fb_test_app', applicationId: 'app', applicationName: 'App', name: 'Claude', description: '',
    baseUrl, applicationKey: 'app-test-key', wireModel: 'claude-opus-4-6', protocol: 'anthropic-messages',
    contextWindow: 200_000, maxTokens: 4096, reasoning: { supported_efforts: ['off', 'custom-deep'] } }
}

function options(patch: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'fb_test_app', model: 'claude-opus-4-6', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], ...patch }
}

async function collect(baseUrl: string, input = options()): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of streamAnthropic(entry(baseUrl), input)) result.push(chunk)
  return result
}

function event(response: ServerResponse, type: string, data: Record<string, unknown>): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function begin(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  event(response, 'message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } })
}

function finish(response: ServerResponse, reason = 'end_turn'): void {
  event(response, 'message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 7 } })
  event(response, 'message_stop', {})
  response.end()
}

function textResponse(response: ServerResponse): void {
  begin(response)
  event(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  event(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello back' } })
  event(response, 'content_block_stop', { index: 0 })
  finish(response)
}

describe('Anthropic host SDK bridge', () => {
  it('uses /v1/messages and the application key; preserves instructions and exact custom effort', async () => {
    let captured: Record<string, unknown> = {}
    let path: string | undefined
    let key: string | string[] | undefined
    const url = await endpoint((request, body, response) => {
      captured = body; path = request.url; key = request.headers['x-api-key']; textResponse(response)
    })
    const chunks = await collect(url, options({ system: 'Base instructions', reasoningEffort: 'custom-deep' as never,
      stop: ['DONE'], maxTokens: 2000,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'System instruction' }] },
        { role: 'developer', content: [{ type: 'text', text: 'Developer instruction' }] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ] as GenerateOptions['messages'],
    }))
    expect(path).toBe('/v1/messages')
    expect(key).toBe('app-test-key')
    expect(captured).toMatchObject({ model: 'claude-opus-4-6', stream: true, max_tokens: 2000,
      output_config: { effort: 'custom-deep' }, stop_sequences: ['DONE'] })
    const serialized = JSON.stringify(captured.system)
    expect(serialized).toContain('Base instructions')
    expect(serialized).toContain('System instruction')
    expect(serialized).toContain('Developer instruction')
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello back' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello back' } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { format: 'flowbase-anthropic-v1' } } })
  })

  it('disables thinking for off instead of mapping to a canonical effort', async () => {
    let captured: Record<string, unknown> = {}
    const url = await endpoint((_request, body, response) => { captured = body; textResponse(response) })
    await collect(url, options({ reasoningEffort: 'off' as never }))
    expect(captured.thinking).toEqual({ type: 'disabled' })
    expect(captured.output_config).toBeUndefined()
  })

  it('streams tools and replays native thinking signatures with the matching tool result', async () => {
    const requests: Record<string, unknown>[] = []
    const url = await endpoint((_request, body, response) => {
      requests.push(body)
      if (requests.length > 1) { textResponse(response); return }
      begin(response)
      event(response, 'content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
      event(response, 'content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Need a tool' } })
      event(response, 'content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'native-signature-opaque' } })
      event(response, 'content_block_stop', { index: 0 })
      event(response, 'content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } })
      event(response, 'content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } })
      event(response, 'content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"weather"}' } })
      event(response, 'content_block_stop', { index: 1 })
      finish(response, 'tool_use')
    })
    const tools = [{ name: 'lookup', description: 'Look up a term', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
    const chunks = await collect(url, options({ tools, reasoningEffort: 'custom-deep' as never }))
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'Need a tool' })
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 1, id: 'toolu_1', argumentsDelta: '{"q":' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu_1', name: 'lookup', arguments: '{"q":"weather"}' } })
    const terminal = chunks.find(chunk => chunk.type === 'finish')
    expect(terminal).toMatchObject({ reason: { kind: 'tool-calls' } })
    if (terminal?.type !== 'finish') throw new Error('Missing finish')
    const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    await collect(url, options({ tools, reasoningEffort: 'custom-deep' as never, messages: [
      ...options().messages,
      { role: 'assistant', source: { kind: 'model', provider: 'fb_test_app', model: 'claude-opus-4-6', replayState: terminal.replayState }, content: blocks },
      { role: 'tool', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'Sunny' }] },
    ] as GenerateOptions['messages'] }))
    const messages = requests[1]?.messages as { role: string; content: unknown[] }[]
    expect(messages.find(message => message.role === 'assistant')?.content).toEqual(expect.arrayContaining([
      { type: 'thinking', thinking: 'Need a tool', signature: 'native-signature-opaque' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'weather' } },
    ]))
    expect(JSON.stringify(messages)).toContain('tool_result')
    expect(JSON.stringify(messages)).toContain('Sunny')
  })

  it('surfaces endpoint errors as terminal failures', async () => {
    const url = await endpoint((_request, _body, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid application key' } }))
    })
    const chunks = await collect(url)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { message: expect.stringContaining('Invalid application key') } } })
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.replayState !== undefined)).toBe(false)
  })

  it('cancels an in-flight connection without a successful replay state', async () => {
    const controller = new AbortController()
    const url = await endpoint((_request, _body, response) => { begin(response); controller.abort() })
    const chunks = await collect(url, options({ signal: controller.signal }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
  })

  it('rejects unsupported input before any HTTP request', async () => {
    let requests = 0
    const url = await endpoint((_request, _body, response) => { requests++; textResponse(response) })
    await expect(collect(url, options({ messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] as GenerateOptions['messages'] })))
      .rejects.toThrow('text-only route cannot send image')
    expect(requests).toBe(0)
  })
})
