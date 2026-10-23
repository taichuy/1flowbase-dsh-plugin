import { describe, expect, it, vi } from 'vitest'
import { hostModule } from './host.js'
import type { CompactionAgent, CompactionInput } from '../../src/compaction.js'
import type { ResponsesCompactBlock } from '../../src/protocols/compact-block.js'

vi.mock('../../src/host-module.js', async () => {
  const { hostModule } = await import('./host.js')
  return { loadHostModule: hostModule }
})

describe('native compaction summarizer', () => {
  it('passes the original messages and session to the compact endpoint and preserves opaque output', async () => {
    const { Context } = await hostModule('@deepseek-ai/cordis')
    const { default: Engine } = await import('../../src/compaction.js')
    const ctx = new Context()
    const block: ResponsesCompactBlock = {
      type: 'flowbase-responses-compaction', version: 1, provider: 'app', model: 'model',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }
    const compact = vi.fn(async () => ({ block, usage: { inputTokens: 30, outputTokens: 4 } }))
    ctx.provide('flowbaseProtocols', { resolveRoute: () => ({ protocol: 'responses', remoteCompaction: true }), compact })
    class ExposedEngine extends Engine {
      summarizeRegion(input: CompactionInput, agent: CompactionAgent, signal: AbortSignal) {
        return this.summarize(input, agent, signal)
      }
    }
    const engine = new ExposedEngine(ctx, { auto: false })
    const signal = new AbortController().signal
    const messages: CompactionInput['messages'] = []
    try {
      const result = await engine.summarizeRegion({ messages }, {
        session: { id: 'fixture' as CompactionAgent['session']['id'], requestHeader: () => ({ config: { provider: 'app', model: 'model' } }) },
        options: { provider: 'stale', model: 'stale' },
      }, signal)
      expect(compact).toHaveBeenCalledWith({ provider: 'app', model: 'model', messages, sessionId: 'fixture', purpose: 'compaction', signal })
      expect(result).toEqual({ summary: [block], provider: 'app', model: 'model', usage: { inputTokens: 30, outputTokens: 4 } })
      expect(result.summary[0]).toBe(block)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
