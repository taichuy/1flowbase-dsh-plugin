import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../adapter.js'
import type { ResponsesCompactBlock } from '../protocols/compact-block.js'

/** Host-owned routing and native compaction, shared with preset-local engines. */
export interface FlowbaseProtocols {
  resolveRoute(provider: string, model: string): AdapterModel | undefined
  compact(options: GenerateOptions): Promise<{ block: ResponsesCompactBlock; usage?: TokenUsage }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    flowbaseProtocols: FlowbaseProtocols
  }
}
