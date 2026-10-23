import { describe, expect, it } from 'vitest'
import { parseReasoning } from '../src/reasoning.js'

describe('reasoning JSON boundary', () => {
  it.each([undefined, null, { supported_efforts: [] }])('does not invent capabilities for %j', value => {
    expect(parseReasoning(value)).toEqual({})
  })
  it.each([false, [], {}, { supported_efforts: [''] }, { supported_efforts: [5] },
    { supported_efforts: ['low'], default_effort: 'high' }])('rejects malformed metadata %j', value => {
    expect(() => parseReasoning(value)).toThrow('Invalid model reasoning metadata')
  })
})
