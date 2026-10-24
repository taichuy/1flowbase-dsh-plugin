import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../adapter.js'
import { validCompactOutput, type ResponsesCompactBlock } from './compact-block.js'
import { responsesBody, responsesInput, responsesUsage } from './responses-request.js'
import { responsesChunks } from './responses-events.js'
import { prepareResponsesImages, type AttachmentResolver } from './responses-images.js'
import { responseHeaders } from './metadata.js'
import { ResponsesTransport, responseJson } from './responses-transport.js'

export async function* streamResponses(transport: ResponsesTransport, entry: AdapterModel, options: GenerateOptions, attachments?: AttachmentResolver): AsyncGenerator<StreamChunk> {
  const prepared = await prepareResponsesImages(options, attachments)
  yield* responsesChunks(transport.events(entry, prepared.options, responsesBody(entry, prepared.options, prepared.images)))
}

/** The dedicated HTTP compaction endpoint returns native input items, not a fabricated text summary. */
export async function compactResponses(entry: AdapterModel, options: GenerateOptions, attachments?: AttachmentResolver): Promise<{ block: ResponsesCompactBlock; usage?: TokenUsage }> {
  const controller = new AbortController()
  const signal = AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), controller.signal, AbortSignal.timeout(300_000)])
  try {
    const prepared = await prepareResponsesImages({ ...options, purpose: 'compaction', signal }, attachments)
    const response = await fetch(`${entry.baseUrl}/v1/responses/compact`, {
      method: 'POST', headers: { ...responseHeaders(entry, prepared.options), 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ model: entry.wireModel, input: responsesInput(prepared.options, prepared.images) }),
    })
    const result = await responseJson(response)
    const output = result.output
    if (!validCompactOutput(output)) {
      throw new Error('Responses compaction did not return a native encrypted compaction item')
    }
    const usage = responsesUsage(result.usage)
    return { block: { type: 'flowbase-responses-compaction', version: 1, provider: options.provider, model: options.model, output },
      ...(usage === undefined ? {} : { usage }) }
  } finally { controller.abort() }
}
