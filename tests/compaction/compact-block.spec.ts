import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertCompactRoute, validCompactOutput } from '../../src/protocols/compact-block.js'

function restoredOptions(output: unknown): GenerateOptions {
  // Persisted data is untrusted; deliberately bypass the compile-time envelope in this fixture.
  return JSON.parse(JSON.stringify({ provider: 'p', model: 'm', messages: [{
    role: 'user', id: 'checkpoint', source: { kind: 'compact-checkpoint', compactionId: 'c' },
    content: [{ type: 'flowbase-responses-compaction', version: 1, provider: 'p', model: 'm', output }],
  }] }))
}

describe('restored native compact output validation', () => {
  it.each([
    null, [], [null], ['opaque'], [{}], [{ type: '' }], [{ type: 'message', content: [] }],
    [{ type: 'compaction' }], [{ type: 'compaction', encrypted_content: 12 }],
    [{ type: 'compaction', encrypted_content: '' }], [{ type: 'compaction', encrypted_content: '  ' }],
    [{ type: 'compaction', encrypted_content: 'good' }, { type: 'compaction' }],
  ])('rejects malformed persisted output %j', output => {
    expect(validCompactOutput(output)).toBe(false)
    expect(() => assertCompactRoute(restoredOptions(output), 'responses')).toThrow()
  })

  it('preserves native items and future extension fields without alteration', () => {
    const output = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained' }] },
      { type: 'compaction', encrypted_content: 'opaque+/=\nunchanged', future: { version: 7 } },
      { type: 'future_provider_item', metadata: { accepted: true } },
    ]
    const serialized = JSON.stringify(output)
    const options = restoredOptions(output)
    expect(validCompactOutput(output)).toBe(true)
    expect(() => assertCompactRoute(options, 'responses')).not.toThrow()
    expect(JSON.stringify(output)).toBe(serialized)
    expect(() => assertCompactRoute(options, 'chat-completions')).toThrow()
    expect(() => assertCompactRoute({ ...options, provider: 'other' }, 'responses')).toThrow()
  })
})
