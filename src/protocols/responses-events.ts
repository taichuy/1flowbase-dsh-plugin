import type { ContentBlock, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import { FlowbaseError } from '../errors.js'
import { object, objects, responsesUsage, type JsonObject } from './responses-request.js'

type State = { index: number; kind: 'text' | 'reasoning' | 'tool-call'; text: string; id: string; name: string; closed: boolean }

/** One native Responses stream (SSE and WebSocket carry identical events). */
export async function* responsesChunks(events: AsyncIterable<JsonObject>): AsyncGenerator<StreamChunk> {
  const states = new Map<string, State>()
  const items = new Map<number, JsonObject>()
  const get = function* (key: string, kind: State['kind'], id = '', name = ''): Generator<StreamChunk, State> {
    let state = states.get(key)
    if (state === undefined) {
      state = { index: states.size, kind, text: '', id, name, closed: false }
      states.set(key, state)
      yield { type: 'block-start', index: state.index, blockType: kind }
      if (kind === 'tool-call') yield { type: 'tool-call-delta', index: state.index, id: id as ToolCallId, name, argumentsDelta: '' }
    }
    return state
  }
  const delta = function* (state: State, text: string): Generator<StreamChunk> {
    if (state.closed || text.length === 0) return
    state.text += text
    if (state.kind === 'tool-call') yield { type: 'tool-call-delta', index: state.index, id: state.id as ToolCallId, argumentsDelta: text }
    else yield { type: state.kind === 'text' ? 'text-delta' : 'reasoning-delta', index: state.index, text }
  }
  const close = function* (state: State, text?: string): Generator<StreamChunk> {
    if (state.closed) return
    if (text !== undefined && text.startsWith(state.text)) yield* delta(state, text.slice(state.text.length))
    if (text !== undefined && text !== state.text) throw new Error('Responses final content differs from its streamed prefix')
    const block: ContentBlock = state.kind === 'tool-call'
      ? { type: 'tool-call', id: state.id as ToolCallId, name: state.name, arguments: state.text }
      : { type: state.kind, text: state.text }
    state.closed = true
    yield { type: 'block-end', index: state.index, block }
  }
  const completeItem = function* (item: JsonObject, position: number): Generator<StreamChunk> {
    items.set(position, item)
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error('Malformed Responses function call')
      const state = yield* get(`${position}:tool`, 'tool-call', item.call_id, item.name)
      yield* close(state, item.arguments)
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const [partIndex, part] of item.content.entries()) {
        if (!object(part)) continue
        const text = part.type === 'refusal' ? part.refusal : part.text
        if (typeof text === 'string') yield* close(yield* get(`${position}:text:${partIndex}`, 'text'), text)
      }
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const [partIndex, part] of item.summary.entries()) {
        if (object(part) && typeof part.text === 'string') yield* close(yield* get(`${position}:reasoning:${partIndex}`, 'reasoning'), part.text)
      }
    }
  }
  for await (const event of events) {
    const type = event.type
    const position = typeof event.output_index === 'number' ? event.output_index : 0
    if (type === 'error' || type === 'response.failed') {
      const error = object(event.error) ? event.error : object(event.response) && object(event.response.error) ? event.response.error : event
      throw new FlowbaseError(String(error.code ?? 'RESPONSES_ERROR'), String(error.message ?? 'Responses request failed'))
    }
    if (type === 'response.output_item.added' && object(event.item)) {
      const item = event.item
      items.set(position, item)
      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string') throw new Error('Malformed Responses function call')
        yield* get(`${position}:tool`, 'tool-call', item.call_id, item.name)
      }
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      yield* delta(yield* get(`${position}:text:${String(event.content_index ?? 0)}`, 'text'), String(event.delta ?? ''))
    } else if (type === 'response.reasoning_summary_text.delta') {
      yield* delta(yield* get(`${position}:reasoning:${String(event.summary_index ?? 0)}`, 'reasoning'), String(event.delta ?? ''))
    } else if (type === 'response.function_call_arguments.delta') {
      const item = items.get(position)
      if (item === undefined || typeof item.call_id !== 'string' || typeof item.name !== 'string') throw new Error('Responses arguments arrived before their function call')
      yield* delta(yield* get(`${position}:tool`, 'tool-call', item.call_id, item.name), String(event.delta ?? ''))
    } else if (type === 'response.output_item.done' && object(event.item)) {
      yield* completeItem(event.item, position)
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      if (!object(event.response)) throw new Error('Missing terminal Responses object')
      const response = event.response
      const output = objects(response.output)
      for (const [index, item] of output.entries()) yield* completeItem(item, index)
      for (const state of states.values()) yield* close(state)
      const usage = responsesUsage(response.usage)
      if (usage !== undefined) yield { type: 'usage', usage }
      const incomplete = type === 'response.incomplete'
      if (incomplete && (!object(response.incomplete_details) || response.incomplete_details.reason !== 'max_output_tokens')) {
        throw new FlowbaseError('RESPONSES_INCOMPLETE', `Responses incomplete: ${JSON.stringify(response.incomplete_details)}`)
      }
      yield { type: 'finish', reason: { kind: incomplete ? 'max-tokens' : output.some(item => item.type === 'function_call') ? 'tool-calls' : 'stop' },
        replayState: { response: { format: 'flowbase-responses-v1', output } } }
      return
    }
  }
  throw new FlowbaseError('STREAM_INTERRUPTED', 'Responses stream closed before its terminal event')
}
