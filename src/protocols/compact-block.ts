import type {} from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Native Responses output retained in the normal durable compaction checkpoint. */
export interface ResponsesCompactBlock {
  type: 'flowbase-responses-compaction'
  version: 1
  provider: string
  model: string
  output: Record<string, unknown>[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'flowbase-responses-compaction': ResponsesCompactBlock
  }
}

export function isCompactBlock(block: ContentBlock): block is ResponsesCompactBlock {
  return block.type === 'flowbase-responses-compaction'
}

/** Validate restored native output without discarding provider extension fields. */
export function validCompactOutput(output: unknown): output is Record<string, unknown>[] {
  if (!Array.isArray(output) || output.length === 0) return false
  let hasCompaction = false
  for (const item of output) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)
      || typeof item.type !== 'string' || item.type.trim().length === 0) return false
    if (item.type === 'compaction') {
      if (typeof item.encrypted_content !== 'string' || item.encrypted_content.trim().length === 0) return false
      hasCompaction = true
    }
  }
  return hasCompaction
}

/** Never allow a route change to silently drop native compacted context. */
export function assertCompactRoute(options: GenerateOptions, protocol: string | undefined): void {
  for (const message of options.messages) {
    for (const block of message.content) {
      if (!isCompactBlock(block)) continue
      if (message.role !== 'user' || message.source?.kind !== 'compact-checkpoint'
        || block.version !== 1 || !validCompactOutput(block.output)
        || protocol !== 'responses' || block.provider !== options.provider || block.model !== options.model) {
        throw new Error('This conversation contains native Responses compaction. Keep the original application/model and Responses protocol, or start a new conversation.')
      }
    }
  }
}
