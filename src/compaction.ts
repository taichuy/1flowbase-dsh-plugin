import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from './host-module.js'
import type {} from './compaction/service.js'

/** Public structural subset of the host's protected summarizer API. */
export interface CompactionInput {
  readonly messages: readonly Message[]
  readonly tools?: readonly ToolSchema[]
}

export interface CompactionAgent {
  session: {
    id: NonNullable<GenerateOptions['sessionId']>
    requestHeader(): { config: { provider: string; model: string } } | undefined
  }
  options: { provider?: string; model?: string }
}

export interface NativeSummary {
  summary: ContentBlock[]
  provider: string
  model: string
  usage?: TokenUsage
}

/** The runtime superclass comes from the running host, preserving Cordis identity. */
declare class HostBasicCompactionEngine {
  static inject: string[]
  constructor(ctx: Context, config?: Record<string, unknown>)
  protected summarize(input: CompactionInput, agent: CompactionAgent, signal?: AbortSignal): Promise<NativeSummary>
}

const host = await loadHostModule('@deepseek-ai/dsh-compaction-basic') as {
  BasicCompactionEngine: typeof HostBasicCompactionEngine
}

/** Reuse the host's atomic replacement, locks, rollback and shrink verification. */
export default class FlowbaseCompactionEngine extends host.BasicCompactionEngine {
  static override inject = [...host.BasicCompactionEngine.inject, 'flowbaseProtocols']

  constructor(private readonly flowbaseContext: Context, config?: Record<string, unknown>) {
    super(flowbaseContext, config)
  }

  protected override async summarize(
    input: CompactionInput,
    agent: CompactionAgent,
    signal?: AbortSignal,
  ): Promise<NativeSummary> {
    const target = agent.session.requestHeader()?.config ?? agent.options
    if (target.provider === undefined || target.model === undefined) return super.summarize(input, agent, signal)
    const service = this.flowbaseContext.flowbaseProtocols
    const route = service.resolveRoute(target.provider, target.model)
    if (route?.protocol !== 'responses' || route.remoteCompaction !== true) {
      return super.summarize(input, agent, signal)
    }
    const result = await service.compact({
      provider: target.provider,
      model: target.model,
      messages: [...input.messages],
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      ...(signal === undefined ? {} : { signal }),
    })
    return {
      summary: [result.block],
      provider: target.provider,
      model: target.model,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }
  }
}
