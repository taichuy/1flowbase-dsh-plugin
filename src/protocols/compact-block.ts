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

/** Never allow a route change to silently drop native compacted context. */
export function assertCompactRoute(options: GenerateOptions, protocol: string | undefined): void {
  for (const message of options.messages) {
    for (const block of message.content) {
      if (!isCompactBlock(block)) continue
      if (message.role !== 'user' || message.source?.kind !== 'compact-checkpoint'
        || block.version !== 1 || !Array.isArray(block.output)
        || protocol !== 'responses' || block.provider !== options.provider || block.model !== options.model) {
        throw new Error('This conversation contains native Responses compaction. Keep the original application/model and Responses protocol, or start a new conversation.')
      }
    }
  }
}
