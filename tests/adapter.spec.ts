import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { FlowbaseLlmAdapter, toOpenAiMessages } from '../src/adapter.js'
import type { AdapterModel, AdapterSnapshot } from '../src/adapter.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

async function startServer(handler: (body: Record<string, unknown>, res: import('node:http').ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req)
      handler(body, res)
    })()
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
  return `http://127.0.0.1:${String(address.port)}`
}

function snapshot(baseUrl: string): AdapterSnapshot {
  const entry: AdapterModel = {
    provider: 'fb_dev',
    applicationId: 'app-1',
    name: 'Support flow',
    description: 'Answers tickets',
    baseUrl,
    applicationKey: 'app-token',
    wireModel: 'inner-model',
    contextWindow: 64_000,
    maxTokens: 8_000,
  }
  return {
    providers: new Map([['fb_dev', { name: 'Local', models: new Map([['app-1', entry]]) }]]),
  }
}

function options(): GenerateOptions {
  return {
    provider: 'fb_dev',
    model: 'app-1',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ] as unknown as GenerateOptions['messages'],
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('FlowbaseLlmAdapter', () => {
  it('projects system, user, assistant tool calls and tool results', () => {
    const converted = toOpenAiMessages({
      provider: 'p',
      model: 'm',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system one' }] },
        { role: 'user', content: [{ type: 'text', text: 'run it' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'calling' }, { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }],
        },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file.txt' }] },
      ] as unknown as GenerateOptions['messages'],
    })
    expect(converted[0]).toEqual({ role: 'system', content: 'system one' })
    expect(converted[1]).toEqual({ role: 'user', content: 'run it' })
    expect(converted[2]).toMatchObject({
      role: 'assistant',
      content: 'calling',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    })
    expect(converted[3]).toEqual({ role: 'tool', content: 'file.txt', tool_call_id: 'call-1' })
  })

  it('translates an SSE text completion into text deltas and a terminal finish', async () => {
    const baseUrl = await startServer((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const adapter = new FlowbaseLlmAdapter(() => snapshot(baseUrl))
    const chunks = await collect(adapter.stream(options()))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: ' world' },
    ])
    expect(chunks.find(chunk => chunk.type === 'block-end')).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Hello world' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('assembles streamed tool calls and reports tool-calls', async () => {
    const baseUrl = await startServer((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'bash', arguments: '{"command":' } }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
    const adapter = new FlowbaseLlmAdapter(() => snapshot(baseUrl))
    const chunks = await collect(adapter.stream(options()))
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('retries without tools when the application rejects the tools field', async () => {
    const bodies: Record<string, unknown>[] = []
    const baseUrl = await startServer((body, res) => {
      bodies.push(body)
      if (bodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'tools unsupported' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"fallback"},"finish_reason":"stop"}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const adapter = new FlowbaseLlmAdapter(() => snapshot(baseUrl))
    const chunks = await collect(adapter.stream({
      ...options(),
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
    }))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.tools).toBeDefined()
    expect(bodies[1]?.tools).toBeUndefined()
    expect(chunks.find(chunk => chunk.type === 'text-delta')).toMatchObject({ text: 'fallback' })
  })
})
