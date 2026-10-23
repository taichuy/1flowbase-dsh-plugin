import type { ContentBlock, GenerateOptions, ReplayEnvelope, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../adapter.js'
import { assertCompactRoute, isCompactBlock } from './compact-block.js'

export type JsonObject = Record<string, unknown>
export function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function objects(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || !value.every(object)) throw new Error('Invalid Responses output array')
  return value
}
function textContent(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'file') return `[file: ${block.attachment.name}]`
    if (block.type === 'image') throw new Error('This imported route does not support image input')
    return ''
  }).join('')
}

/** Keep provider-native assistant output and compact checkpoints losslessly on their original route. */
export function responsesInput(options: GenerateOptions): JsonObject[] {
  assertCompactRoute(options, 'responses')
  const input: JsonObject[] = []
  if (options.system) input.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    const compact = message.content.filter(isCompactBlock)
    if (compact.length > 0) {
      if (compact.length !== 1) throw new Error('Invalid Responses checkpoint: expected one native output block')
      input.push(...objects(compact[0]!.output))
      continue
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: textContent(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const source = message.source
      const replay = source?.replayState as ReplayEnvelope | undefined
      const saved = replay?.response
      if (source?.provider === options.provider && source.model === options.model
        && object(saved) && saved.format === 'flowbase-responses-v1') {
        input.push(...objects(saved.output))
        continue
      }
      // Cross-route history has no valid encrypted reasoning; retain visible answer and tool pairing.
      const text = textContent(message.content)
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const block of message.content) {
        if (block.type === 'tool-call') input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
      }
      continue
    }
    const text = textContent(message.content)
    if (text) input.push({ role: message.role, content: text })
  }
  return input
}

export function responsesBody(entry: AdapterModel, options: GenerateOptions): JsonObject {
  const body: JsonObject = { model: entry.wireModel, input: responsesInput(options), store: false, stream: true,
    include: ['reasoning.encrypted_content'] }
  if (options.tools?.length) body.tools = options.tools.map(tool => ({
    type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
  }))
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: options.reasoningEffort, summary: 'auto' }
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.stop?.length) throw new Error('Responses does not support stop sequences')
  return body
}

export function responsesUsage(raw: unknown): TokenUsage | undefined {
  if (!object(raw)) return undefined
  const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0
  const output = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0
  const cached = object(raw.input_tokens_details) && typeof raw.input_tokens_details.cached_tokens === 'number'
    ? raw.input_tokens_details.cached_tokens : 0
  const reasoning = object(raw.output_tokens_details) && typeof raw.output_tokens_details.reasoning_tokens === 'number'
    ? raw.output_tokens_details.reasoning_tokens : undefined
  return { inputTokens: Math.max(0, input - cached), outputTokens: output,
    totalTokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : input + output,
    ...(cached ? { cacheReadTokens: cached } : {}), ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) }
}
