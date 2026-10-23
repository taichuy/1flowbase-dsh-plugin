import { describe, expect, it } from 'vitest'
import type { ResponsesCompactBlock } from '../../src/protocols/compact-block.js'
import { assertCompactRoute } from '../../src/protocols/compact-block.js'
import { hostModule } from './host.js'

describe('native compaction checkpoint persistence', () => {
  it('restores native encrypted output inside an existing durable checkpoint event', async () => {
    const { validateStoredEvents } = await hostModule('@deepseek-ai/dsh-session-persistence')
    const { SESSION_FORMAT_VERSION } = await hostModule('@deepseek-ai/dsh-session')
    const { createUserMessage } = await hostModule('@deepseek-ai/dsh-llm')
    const { compactCheckpointSource } = await hostModule('@deepseek-ai/dsh-compaction')
    const block: ResponsesCompactBlock = {
      type: 'flowbase-responses-compaction', version: 1, provider: 'fixture', model: 'model',
      output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque+/=\nuntouched' }],
    }
    const message = createUserMessage({ content: [block], source: compactCheckpointSource('compaction-1') })
    const persisted = JSON.stringify([
      { seq: 0, time: 1, type: 'compaction/start', data: { compactionId: 'compaction-1', turn: null } },
      { seq: 1, time: 2, type: 'user/message', data: message },
      { seq: 2, time: 3, type: 'compaction/end', data: { compactionId: 'compaction-1', turn: null } },
    ])
    const restored = validateStoredEvents({ id: 'fixture', version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: true }, JSON.parse(persisted))
    const restoredBlock = restored[1].data.content[0]
    expect(restoredBlock).toEqual(block)
    expect(Object.isFrozen(restoredBlock)).toBe(true)
    expect(JSON.stringify(restoredBlock.output)).toBe(JSON.stringify(block.output))
    expect(() => assertCompactRoute({ provider: 'fixture', model: 'model', messages: [restored[1].data] }, 'responses')).not.toThrow()
    expect(() => assertCompactRoute({ provider: 'other', model: 'model', messages: [restored[1].data] }, 'responses')).toThrow()
    expect(() => assertCompactRoute({ provider: 'fixture', model: 'model', messages: [restored[1].data] }, 'chat-completions')).toThrow()
  })
})
