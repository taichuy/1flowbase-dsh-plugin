import type { ContentBlock, GenerateOptions, ReplayEnvelope, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Context, JsonObject, Model, Tool, Usage } from '@earendil-works/pi-ai'
import type * as Pi from '@earendil-works/pi-ai'
import type * as Anthropic from '@earendil-works/pi-ai/api/anthropic-messages'
import type { AdapterModel } from '../adapter.js'
import { FlowbaseError } from '../errors.js'
import { loadHostModule } from '../host-module.js'

const FORMAT = 'flowbase-anthropic-v1'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function text(content: readonly ContentBlock[]): string {
  return content.map(block => {
    if (block.type === 'text') return block.text
    throw new FlowbaseError('INVALID_REQUEST', `Anthropic text-only route cannot send ${block.type} blocks in this role`)
  }).join('\n')
}

function tool(schema: ToolSchema): Tool {
  return { name: schema.name, description: schema.description, parameters: schema.parameters as Tool['parameters'] }
}

function replayMessage(source: unknown): AssistantMessage | undefined {
  if (!object(source)) return undefined
  const envelope: unknown = source.replayState
  if (!object(envelope) || !object(envelope.response) || envelope.response.format !== FORMAT) return undefined
  const message = envelope.response.message
  if (!object(message) || message.role !== 'assistant' || message.api !== 'anthropic-messages' || !Array.isArray(message.content)) {
    throw new FlowbaseError('INVALID_REQUEST', 'Invalid Anthropic replay state')
  }
  return structuredClone(message) as unknown as AssistantMessage
}

function contextOf(entry: AdapterModel, options: GenerateOptions): Context {
  const context: Context = { messages: [], tools: (options.toolHistory?.tools ?? options.tools ?? []).map(tool) }
  if (options.system !== undefined) context.systemPrompt = options.system
  const names = new Map<string, string>()
  for (const message of options.messages) {
    const timestamp = Date.now()
    if (message.role === 'system') {
      context.messages.push({ role: 'system', content: text(message.content), timestamp })
    } else if (message.role === 'developer') {
      const additions = options.toolHistory?.updates.find(update => update.messageId === message.id)?.additions ?? options.tools ?? []
      const toolsAdded: Tool[] = []
      const toolsRemoved: { name: string }[] = []
      const instructions: ContentBlock[] = []
      for (const block of message.content) {
        if (block.type === 'tool-addition') {
          const definition = additions.find(candidate => candidate.name === block.toolName)
          if (definition === undefined) throw new FlowbaseError('INVALID_REQUEST', `Missing tool definition: ${block.toolName}`)
          toolsAdded.push(tool(definition))
        } else if (block.type === 'tool-removal') toolsRemoved.push({ name: block.toolName })
        else instructions.push(block)
      }
      context.messages.push({ role: 'system', content: text(instructions), toolsAdded, toolsRemoved, timestamp })
    } else if (message.role === 'user') {
      context.messages.push({ role: 'user', content: text(message.content), timestamp })
    } else if (message.role === 'tool') {
      context.messages.push({ role: 'toolResult', toolCallId: message.toolCallId,
        toolName: names.get(message.toolCallId) ?? '', content: [{ type: 'text', text: text(message.content) }],
        isError: message.isError ?? false, timestamp })
    } else {
      const native = replayMessage(message.source)
      if (native !== undefined && native.model === entry.wireModel && native.provider === entry.provider) {
        context.messages.push(native)
        for (const block of native.content) if (block.type === 'toolCall') names.set(block.id, block.name)
        continue
      }
      const content: AssistantMessage['content'] = message.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text }
        // Cross-provider reasoning has no valid Anthropic signature; preserve it as text.
        if (block.type === 'reasoning') return { type: 'text', text: block.text }
        if (block.type === 'tool-call') {
          const args: unknown = JSON.parse(block.arguments)
          if (!object(args)) throw new FlowbaseError('INVALID_REQUEST', 'Tool arguments must be a JSON object')
          names.set(block.id, block.name)
          return { type: 'toolCall', id: block.id, name: block.name, arguments: args as JsonObject }
        }
        throw new FlowbaseError('INVALID_REQUEST', `Anthropic text-only route cannot send ${block.type} blocks`)
      })
      context.messages.push({ role: 'assistant', content, api: 'anthropic-messages', provider: entry.provider,
        model: entry.wireModel, usage: emptyUsage(), stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop', timestamp })
    }
  }
  return context
}

/** Translate public Pi events while retaining the native message for signature-safe replay. */
export async function* streamAnthropic(entry: AdapterModel, options: GenerateOptions): AsyncGenerator<StreamChunk> {
  const context = contextOf(entry, options)
  const [pi, anthropic] = await Promise.all([
    loadHostModule('@earendil-works/pi-ai') as Promise<typeof Pi>,
    loadHostModule('@earendil-works/pi-ai/api/anthropic-messages') as Promise<typeof Anthropic>,
  ])
  const model: Model<'anthropic-messages'> = {
    id: entry.wireModel, name: entry.name, api: 'anthropic-messages', provider: entry.provider,
    baseUrl: entry.baseUrl.replace(/\/$/u, ''), reasoning: entry.reasoning !== undefined,
    input: ['text'], contextWindow: entry.contextWindow, maxTokens: entry.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const controller = new AbortController()
  const signals = [controller.signal, AbortSignal.timeout(5 * 60 * 1000)]
  if (options.signal !== undefined) signals.push(options.signal)
  const effort = options.reasoningEffort
  const stream = anthropic.stream(model, pi.normalizeContext(context), {
    apiKey: entry.applicationKey, signal: AbortSignal.any(signals), maxRetries: 0,
    maxTokens: options.maxTokens ?? entry.maxTokens,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(effort === undefined ? {} : { thinkingEnabled: effort !== 'off' }),
    onPayload: payload => {
      if (!object(payload)) throw new FlowbaseError('INVALID_REQUEST', 'Invalid Anthropic request payload')
      if (effort === 'off') payload.thinking = { type: 'disabled' }
      else if (effort !== undefined) {
        payload.output_config = { ...(object(payload.output_config) ? payload.output_config : {}), effort }
      }
      if (options.stop !== undefined) payload.stop_sequences = options.stop
      return payload
    },
  })
  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'start': break
        case 'text_start':
          yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }; break
        case 'thinking_start':
          yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }; break
        case 'text_delta':
          yield { type: 'text-delta', index: event.contentIndex, text: event.delta }; break
        case 'thinking_delta':
          yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }; break
        case 'text_end':
          yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }; break
        case 'thinking_end':
          yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }; break
        case 'toolcall_start': {
          const call = event.partial.content[event.contentIndex]
          if (call?.type !== 'toolCall') throw new FlowbaseError('SERVER', 'Missing Anthropic tool call')
          yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: event.contentIndex, id: call.id as never, name: call.name, argumentsDelta: '' }
          break
        }
        case 'toolcall_delta': {
          const call = event.partial.content[event.contentIndex]
          if (call?.type !== 'toolCall') throw new FlowbaseError('SERVER', 'Missing Anthropic tool call')
          yield { type: 'tool-call-delta', index: event.contentIndex, id: call.id as never, argumentsDelta: event.delta }
          break
        }
        case 'toolcall_end':
          if (event.toolCall.argumentsError !== undefined) throw new FlowbaseError('SERVER', event.toolCall.argumentsError)
          yield { type: 'block-end', index: event.contentIndex, block: { type: 'tool-call', id: event.toolCall.id as never,
            name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) } }; break
        case 'done': {
          const usage = event.message.usage
          yield { type: 'usage', usage: { inputTokens: usage.input, outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, totalTokens: usage.totalTokens } }
          const replayState: ReplayEnvelope = { response: { format: FORMAT, message: event.message } }
          yield { type: 'finish', reason: { kind: event.reason === 'toolUse' ? 'tool-calls' : event.reason === 'length' ? 'max-tokens' : 'stop' }, replayState }
          return
        }
        case 'error':
          yield { type: 'finish', reason: { kind: event.reason === 'aborted' ? 'aborted' : 'error',
            failure: { message: event.error.errorMessage ?? 'Anthropic request failed', code: event.reason === 'aborted' ? 'ABORTED' : 'SERVER' } } }
          return
      }
    }
    throw new FlowbaseError('SERVER', 'Anthropic stream ended without a terminal event')
  } finally {
    controller.abort()
  }
}
