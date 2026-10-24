import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from '../host-module.js'

/** Only public attachment capabilities are used; no host filesystem access. */
export type ResponsesAttachments = Pick<AttachmentStore, 'readImage' | 'imageLimits'>
export type AttachmentResolver = () => ResponsesAttachments | undefined

/** Resolve retained images once per request, applying the deployment's admission limits to the whole request. */
export async function prepareResponsesImages(options: GenerateOptions, resolve?: AttachmentResolver): Promise<{
  options: GenerateOptions; images: ReadonlyMap<string, string>
}> {
  options.signal?.throwIfAborted()
  const images = new Map<string, string>()
  if (!options.messages.some(message => message.content.some(block => block.type === 'image'))) return { options, images }
  const host = await loadHostModule('@deepseek-ai/dsh-llm') as typeof import('@deepseek-ai/dsh-llm')
  const messages = host.projectOffloadedImages(options.messages, ref => host.offloadedImageText(ref))
  const projected = { ...options, messages: [...messages] }
  const refs = messages.flatMap(message => message.content.flatMap(block => {
    if (block.type !== 'image') return []
    if (message.role !== 'user' && message.role !== 'tool') throw new Error('Responses images are supported only in user messages and tool results')
    return [block.attachment]
  }))
  if (!refs.length) return { options: projected, images }
  const attachments = resolve?.()
  if (attachments === undefined) throw new Error('Responses image input requires the host attachment service')
  const limits = attachments.imageLimits
  // Bound represented bytes (including repeated occurrences) before base64 allocation.
  if (refs.length > limits.maxImagesPerMessage) throw new Error('Responses whole request history exceeds the host image-count limit; reduce retained images before retrying')
  let encodedBytes = 0
  const descriptors = new Map<string, string>()
  for (const ref of refs) {
    const descriptor = JSON.stringify([ref.mediaType, ref.bytes, ref.width, ref.height, ref.name,
      ref.originalDimensions?.width, ref.originalDimensions?.height])
    const previous = descriptors.get(ref.attachmentId)
    if (previous !== undefined && previous !== descriptor) throw new Error('Responses request contains inconsistent references for the same attachment')
    descriptors.set(ref.attachmentId, descriptor)
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > limits.maxImageBytes || !limits.mediaTypes.includes(ref.mediaType)) {
      throw new Error('Responses attachment exceeds the host image policy')
    }
    encodedBytes += 4 * Math.ceil(ref.bytes / 3)
  }
  if (encodedBytes > limits.maxMessageImageBytes) throw new Error('Responses whole request history exceeds the host encoded image-byte limit; reduce retained images before retrying')
  for (const ref of refs) {
    options.signal?.throwIfAborted()
    if (images.has(ref.attachmentId)) continue
    const stored = await attachments.readImage(ref, options.signal)
    options.signal?.throwIfAborted()
    // The store verifies the reference; refuse a broken provider before encoding.
    if (stored.data.byteLength !== ref.bytes || stored.ref.mediaType !== ref.mediaType) throw new Error('Responses attachment verification failed')
    images.set(ref.attachmentId, `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`)
  }
  return { options: projected, images }
}
