import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { prepareResponsesImages, type ResponsesAttachments } from '../../src/protocols/responses-images.js'
import { responsesInput } from '../../src/protocols/responses-request.js'
import { compactResponses, streamResponses } from '../../src/protocols/responses.js'
import { FlowbaseLlmAdapter, type AdapterModel } from '../../src/adapter.js'
import type { ResponsesTransport } from '../../src/protocols/responses-transport.js'

const ref: ImageAttachmentRef = { attachmentId: 'sha256:fixture' as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
const image = { type: 'image' as const, attachment: ref }
const entry: AdapterModel = { provider: 'p', applicationId: 'a', applicationName: 'App', name: 'm', description: '', baseUrl: 'https://example.invalid', applicationKey: 'key', wireModel: 'm', contextWindow: 1000, maxTokens: 100, protocol: 'responses', remoteCompaction: true }
function request(content: unknown[] = [{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }]): GenerateOptions {
  return { provider: 'p', model: 'm', messages: [{ role: 'user', content }] } as GenerateOptions
}
function store(): ResponsesAttachments {
  return {
    imageLimits: { maxImagesPerMessage: 20, maxImageBytes: 100, maxMessageImageBytes: 1000, maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'] },
    readImage: vi.fn(async () => ({ ref, data: new Uint8Array([1, 2, 3]) })),
  }
}
afterEach(() => vi.unstubAllGlobals())
describe('Responses durable attachment projection', () => {
  it('preserves ordered text/images and durable input while resolving duplicate references once', async () => {
    const attachments = store()
    const options = request([{ type: 'text', text: 'before' }, image, image, { type: 'text', text: 'after' }])
    const original = JSON.stringify(options)
    const prepared = await prepareResponsesImages(options, () => attachments)
    expect(responsesInput(prepared.options, prepared.images)).toEqual([{ role: 'user', content: [
      { type: 'input_text', text: 'before' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
      { type: 'input_image', image_url: 'data:image/png;base64,AQID' }, { type: 'input_text', text: 'after' },
    ] }])
    expect(attachments.readImage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(options)).toBe(original)
  })
  it.each([
    { bytes: 4 }, { mediaType: 'image/jpeg' }, { width: 2 }, { height: 2 },
    { name: 'changed.png' }, { originalDimensions: { width: 2, height: 2 } },
  ])('rejects inconsistent duplicate attachment descriptors before reading: %j', changed => {
    const attachments = store()
    return expect(prepareResponsesImages(request([image, { ...image, attachment: { ...ref, ...changed } }]), () => attachments))
      .rejects.toThrow('inconsistent references').then(() => { expect(attachments.readImage).not.toHaveBeenCalled() })
  })
  it('serializes tool result images using Responses content-item output arrays', async () => {
    const options = request()
    options.messages = [{ role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'result' }, image] }] as GenerateOptions['messages']
    const prepared = await prepareResponsesImages(options, store)
    expect(responsesInput(prepared.options, prepared.images)).toEqual([{ type: 'function_call_output', call_id: 'call', output: [
      { type: 'input_text', text: 'result' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
    ] }])
  })
  it('never reads offloaded references, including when no store is mounted', async () => {
    const prepared = await prepareResponsesImages(request([{ ...image, offloaded: true }]))
    expect(prepared.images.size).toBe(0)
    expect(JSON.stringify(responsesInput(prepared.options))).toContain('image omitted to fit request image limits')
  })
  it('rejects missing/corrupt attachments and unsupported roles without dropping images', async () => {
    await expect(prepareResponsesImages(request())).rejects.toThrow('attachment service')
    const attachments = store()
    vi.mocked(attachments.readImage).mockRejectedValueOnce(new Error('digest mismatch'))
    await expect(prepareResponsesImages(request(), () => attachments)).rejects.toThrow('digest mismatch')
    const options = request(); options.messages[0]!.role = 'assistant'
    await expect(prepareResponsesImages(options, () => attachments)).rejects.toThrow('only in user messages and tool results')
  })
  it('bounds occurrence count and encoded bytes before any attachment read', async () => {
    const attachments = store()
    attachments.imageLimits.maxImagesPerMessage = 1
    await expect(prepareResponsesImages(request([image, image]), () => attachments)).rejects.toThrow('image-count')
    attachments.imageLimits.maxMessageImageBytes = 3
    await expect(prepareResponsesImages(request([image]), () => attachments)).rejects.toThrow('encoded image-byte')
    expect(attachments.readImage).not.toHaveBeenCalled()
  })
  it('forwards cancellation and refuses data returned after cancellation', async () => {
    const attachments = store(); const controller = new AbortController()
    vi.mocked(attachments.readImage).mockImplementationOnce(async (_ref, signal) => {
      expect(signal).toBe(controller.signal); controller.abort(new Error('cancel image'))
      return { ref, data: new Uint8Array([1, 2, 3]) }
    })
    await expect(prepareResponsesImages({ ...request(), signal: controller.signal }, () => attachments)).rejects.toThrow('cancel image')
  })
  it('uses identical projection for streaming and native compaction', async () => {
    const attachments = store(); let streaming: unknown
    const transport = { async *events(_entry: unknown, _options: unknown, body: Record<string, unknown>) {
      streaming = body.input
      yield { type: 'response.completed', response: { id: 'r', output: [] } }
    } } as unknown as ResponsesTransport
    for await (const _chunk of streamResponses(transport, entry, request(), () => attachments)) { /* drain */ }
    let compacting: unknown
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(init.headers.session_id).toBeUndefined()
      compacting = JSON.parse(init.body).input
      return Response.json({ output: [{ type: 'compaction', encrypted_content: 'opaque' }] })
    }))
    await compactResponses(entry, request(), () => attachments)
    expect(compacting).toEqual(streaming)
    expect(JSON.stringify(compacting)).toContain('data:image/png;base64,AQID')
  })
  it('advertises only implemented image routes with a mounted attachment store', async () => {
    const attachments = store()
    const adapter = new FlowbaseLlmAdapter(() => ({ providers: new Map([['p', { name: 'App', models: new Map([['m', entry]]) }]]) }), undefined, () => attachments)
    try {
      expect((await adapter.resolveModel('p', 'm')).inputModalities).toEqual(['text', 'image'])
      expect((await adapter.listModels('p'))[0]!.inputModalities).toEqual(['text', 'image'])
      expect((await adapter.prepareCall('p', 'm')).model.inputModalities).toEqual(['text', 'image'])
    } finally { adapter.dispose() }
    const unsupported = new FlowbaseLlmAdapter(() => ({ providers: new Map([['p', { name: 'App', models: new Map([['m', { ...entry, protocol: 'chat-completions' as const }]]) }]]) }), undefined, () => attachments)
    try { expect((await unsupported.resolveModel('p', 'm')).inputModalities).toEqual(['text']) } finally { unsupported.dispose() }
    const textAdapter = new FlowbaseLlmAdapter(() => ({ providers: new Map([['p', { name: 'App', models: new Map([['m', entry]]) }]]) }))
    try { expect((await textAdapter.resolveModel('p', 'm')).inputModalities).toEqual(['text']) } finally { textAdapter.dispose() }
  })
})
