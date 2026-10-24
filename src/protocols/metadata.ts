import { createHash, randomUUID } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../adapter.js'

function scope(entry: AdapterModel, options: GenerateOptions): string | undefined {
  if (options.sessionId === undefined || options.purpose !== undefined) return undefined
  return createHash('sha256').update(JSON.stringify([
    '1flowbase', entry.baseUrl, options.provider, entry.wireModel, options.sessionId,
  ])).digest('hex')
}

/** Honest client identity; opaque scoped IDs never contain credentials or local paths. */
export function responseHeaders(entry: AdapterModel, options: GenerateOptions): Record<string, string> {
  const session = scope(entry, options)
  return {
    authorization: `Bearer ${entry.applicationKey}`,
    'user-agent': '1flowbase-dsh-plugin',
    'x-client-request-id': randomUUID(),
    ...(session === undefined ? {} : { session_id: session }),
  }
}

/** Cache affinity is a hint, never a replacement for canonical request history. */
export function responseMetadata(entry: AdapterModel, options: GenerateOptions): { prompt_cache_key?: string } {
  const session = scope(entry, options)
  return session === undefined ? {} : { prompt_cache_key: session }
}
