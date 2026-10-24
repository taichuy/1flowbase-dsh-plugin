import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  LlmImageRequestPricing,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  TokenUsage,
  ToolCallBlock,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { dshReasoning } from './reasoning.js'
import type { ApplicationProtocol, ModelReasoning } from './shared/api.js'
import { assertCompactRoute } from './protocols/compact-block.js'
import { streamResponses, compactResponses } from './protocols/responses.js'
import { streamAnthropic } from './protocols/anthropic.js'
import { ResponsesTransport, type ResponsesTransportOptions } from './protocols/responses-transport.js'
import { FlowbaseError } from './errors.js'
import type { AttachmentResolver } from './protocols/responses-images.js'

/** One model of one imported application, as the adapter needs it for a request. */
export interface AdapterModel {
  provider: string
  applicationId: string
  /** The application's own name; the provider group label in the model selector. */
  applicationName: string
  name: string
  description: string
  baseUrl: string
  applicationKey: string
  /** Model id sent to the application; also the DSH-facing model id. */
  wireModel: string
  contextWindow: number
  maxTokens: number
  protocol?: ApplicationProtocol
  remoteCompaction?: boolean
  reasoning?: ModelReasoning
}

/** Provider and model view the registry projects into the adapter. */
export interface AdapterSnapshot {
  providers: ReadonlyMap<string, {
    name: string
    models: ReadonlyMap<string, AdapterModel>
  }>
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

interface OpenAiToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: OpenAiToolCallDelta[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
  error?: { message?: string; code?: string }
}

function textOf(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted: this route is text-only]')
    else if (block.type === 'file') parts.push(`[file: ${block.attachment.name}]`)
  }
  return parts.join('\n')
}

function messageText(message: RequestMessage): string {
  return textOf(message.content)
}

/** Project durable Harness messages into the OpenAI Chat Completions shape. */
export function toOpenAiMessages(options: GenerateOptions): OpenAiMessage[] {
  const system: string[] = []
  if (options.system !== undefined && options.system.length > 0) system.push(options.system)
  const converted: OpenAiMessage[] = []
  for (const message of options.messages) {
    switch (message.role) {
      case 'system':
        if (messageText(message).length > 0) system.push(messageText(message))
        break
      case 'developer':
        // Developer messages carry tool declarations/removals, not user text.
        break
      case 'user':
        converted.push({ role: 'user', content: messageText(message) })
        break
      case 'assistant': {
        const toolCalls = message.content
          .filter((block): block is ToolCallBlock => block.type === 'tool-call')
          .map(block => ({
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: block.arguments },
          }))
        const text = textOf(message.content)
        if (toolCalls.length > 0) {
          converted.push({ role: 'assistant', content: text.length > 0 ? text : null, tool_calls: toolCalls })
        } else {
          converted.push({ role: 'assistant', content: text })
        }
        break
      }
      case 'tool':
        converted.push({ role: 'tool', content: messageText(message), tool_call_id: message.toolCallId })
        break
    }
  }
  if (system.length > 0) converted.unshift({ role: 'system', content: system.join('\n\n') })
  return converted
}

/** Project Harness tool schemas into OpenAI function declarations. */
export function toOpenAiTools(tools: readonly ToolSchema[] | undefined): unknown[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

function usageOf(raw: OpenAiChunk['usage']): TokenUsage {
  const input = raw?.prompt_tokens ?? 0
  const output = raw?.completion_tokens ?? 0
  const cached = raw?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    ...(raw?.total_tokens === undefined ? {} : { totalTokens: raw.total_tokens }),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

function finishOf(reason: string | null | undefined, sawToolCall: boolean): FinishReason {
  if (sawToolCall || reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'content_filter') return { kind: 'stop' }
  return { kind: 'stop' }
}

function classifyStatus(status: number, message: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 422) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return 'FLOWBASE_ERROR'
}

async function* linesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).replace(/\r$/u, '')
        buffer = buffer.slice(newline + 1)
        yield line
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) yield buffer.replace(/\r$/u, '')
  } finally {
    reader.releaseLock()
  }
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of linesOf(body)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length > 0) yield data
  }
}

/** Streams one imported agent-flow application through its OpenAI-compatible endpoint. */
export class FlowbaseLlmAdapter {
  private readonly responses: ResponsesTransport
  constructor(private readonly snapshot: () => AdapterSnapshot, transportOptions: ResponsesTransportOptions = {
    connectTimeoutMs: 10_000, idleTimeoutMs: 300_000, retryDelayMs: 250,
  }, private readonly attachments?: AttachmentResolver) { this.responses = new ResponsesTransport(transportOptions) }

  dispose(): void { this.responses.dispose() }

  compact(options: GenerateOptions) {
    const entry = this.snapshot().providers.get(options.provider)?.models.get(options.model)
    if (entry?.protocol !== 'responses' || entry.remoteCompaction !== true) throw new FlowbaseError('INVALID_REQUEST', 'Remote compaction requires an enabled Responses application')
    return compactResponses(entry, options, this.attachments)
  }

  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined {
    return undefined
  }

  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const entry = this.snapshot().providers.get(provider)?.models.get(model)
    if (entry === undefined) throw new FlowbaseError('model/not-found', `unknown imported model ${provider}/${model}`)
    return {
      model: this.describeModel(entry),
      stream: options => this.streamEntry(entry, options),
    }
  }

  providerInfo(provider: string): LlmProviderInfo {
    const entry = this.snapshot().providers.get(provider)
    return { id: provider, name: entry?.name ?? provider }
  }

  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entry = this.snapshot().providers.get(provider)
    if (entry === undefined) return Promise.resolve([])
    return Promise.resolve([...entry.models.values()].map(model => ({
      provider,
      id: model.wireModel,
      name: model.name,
      description: model.description,
      inputModalities: this.modalities(model),
      ...dshReasoning(model.reasoning),
    })))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.snapshot().providers.get(provider)?.models.get(model)
    if (entry === undefined) throw new FlowbaseError('model/not-found', `unknown imported model ${provider}/${model}`)
    return this.describeModel(entry)
  }

  private modalities(entry: AdapterModel): readonly ('text' | 'image')[] {
    return entry.protocol === 'responses' && this.attachments?.() !== undefined ? ['text', 'image'] : ['text']
  }

  private describeModel(entry: AdapterModel): LlmResolvedModelInfo {
    return {
      provider: entry.provider,
      id: entry.wireModel,
      name: entry.name,
      description: entry.description,
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: entry.maxTokens,
      inputModalities: this.modalities(entry),
      ...dshReasoning(entry.reasoning),
    }
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const entry = this.snapshot().providers.get(options.provider)?.models.get(options.model)
    if (entry === undefined) throw new FlowbaseError('model/not-found', `unknown imported model ${options.provider}/${options.model}`)
    yield* this.streamEntry(entry, options)
  }

  private async *streamEntry(entry: AdapterModel, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    assertCompactRoute(options, entry.protocol ?? 'chat-completions')
    if (entry.protocol === 'responses') { yield* streamResponses(this.responses, entry, options, this.attachments); return }
    if (entry.protocol === 'anthropic-messages') { yield* streamAnthropic(entry, options); return }
    const tools = toOpenAiTools(options.tools)
    let response: Response
    try {
      response = await this.send(entry, options, tools)
      if (response.status === 400 && tools !== undefined) {
        await response.body?.cancel()
        response = await this.send(entry, options, undefined)
      }
    } catch (error) {
      if (error instanceof FlowbaseError) throw error
      throw new FlowbaseError('network', `无法连接 1flowbase 应用: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error })
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new FlowbaseError(
        classifyStatus(response.status, text),
        `1flowbase 应用返回 HTTP ${String(response.status)}: ${text.slice(0, 500)}`,
        response.status,
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream') || response.body === null) {
      yield* this.nonStreaming(response)
      return
    }

    yield* this.streaming(response.body, options.signal)
  }

  private async send(entry: AdapterModel, options: GenerateOptions, tools: unknown[] | undefined): Promise<Response> {
    const body: Record<string, unknown> = {
      model: entry.wireModel,
      messages: toOpenAiMessages(options),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (tools !== undefined) body.tools = tools
    if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop

    const signals: AbortSignal[] = []
    if (options.signal !== undefined) signals.push(options.signal)
    signals.push(AbortSignal.timeout(5 * 60 * 1000))
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${entry.applicationKey}`,
      },
      body: JSON.stringify(body),
    }
    if (signal !== undefined) init.signal = signal
    return await fetch(`${entry.baseUrl}/v1/chat/completions`, init)
  }

  private async *streaming(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): AsyncGenerator<StreamChunk> {
    let nextIndex = 0
    let textIndex: number | undefined
    let text = ''
    let reasoningIndex: number | undefined
    let reasoning = ''
    const toolIndexes = new Map<number, { index: number; id: string; name: string; arguments: string }>()
    let finishReason: string | null | undefined
    let usage: TokenUsage | undefined
    let sawToolCall = false

    for await (const data of sseData(body)) {
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      if (data === '[DONE]') break
      let chunk: OpenAiChunk
      try {
        chunk = JSON.parse(data) as OpenAiChunk
      } catch {
        continue
      }
      if (chunk.error !== undefined) {
        throw new FlowbaseError('FLOWBASE_ERROR', chunk.error.message ?? '1flowbase application returned an error')
      }
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta?.reasoning_content !== undefined && delta.reasoning_content !== null && delta.reasoning_content.length > 0) {
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoning += delta.reasoning_content
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
      }
      if (delta?.reasoning !== undefined && delta.reasoning !== null && delta.reasoning.length > 0) {
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoning += delta.reasoning
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning }
      }
      if (delta?.content !== undefined && delta.content !== null && delta.content.length > 0) {
        if (textIndex === undefined) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        text += delta.content
        yield { type: 'text-delta', index: textIndex, text: delta.content }
      }
      for (const call of delta?.tool_calls ?? []) {
        sawToolCall = true
        const key = call.index ?? 0
        let state = toolIndexes.get(key)
        if (state === undefined) {
          state = {
            index: nextIndex++,
            id: call.id ?? `fb_call_${String(key)}_${String(Date.now())}`,
            name: call.function?.name ?? '',
            arguments: '',
          }
          toolIndexes.set(key, state)
          yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: state.index, id: state.id as never, name: state.name, argumentsDelta: '' }
        }
        if (call.id !== undefined && call.id.length > 0) state.id = call.id
        if (call.function?.name !== undefined && call.function.name.length > 0) state.name = call.function.name
        const deltaArguments = call.function?.arguments ?? ''
        if (deltaArguments.length > 0) {
          state.arguments += deltaArguments
          yield { type: 'tool-call-delta', index: state.index, id: state.id as never, argumentsDelta: deltaArguments }
        }
      }
      if (choice?.finish_reason !== undefined) finishReason = choice.finish_reason
      if (chunk.usage !== undefined && chunk.usage !== null) usage = usageOf(chunk.usage)
    }

    if (reasoningIndex !== undefined) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
    }
    if (textIndex !== undefined) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
    }
    for (const state of toolIndexes.values()) {
      yield {
        type: 'block-end',
        index: state.index,
        block: {
          type: 'tool-call',
          id: state.id as never,
          name: state.name,
          arguments: state.arguments.length > 0 ? state.arguments : '{}',
        },
      }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finishOf(finishReason, sawToolCall) }
  }

  private async *nonStreaming(response: Response): AsyncGenerator<StreamChunk> {
    const payload = await response.json() as {
      choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[]
      usage?: OpenAiChunk['usage']
    }
    const choice = payload.choices?.[0]
    const text = choice?.message?.content ?? ''
    if (text.length > 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    if (payload.usage !== undefined && payload.usage !== null) yield { type: 'usage', usage: usageOf(payload.usage) }
    yield { type: 'finish', reason: finishOf(choice?.finish_reason, false) }
  }
}
