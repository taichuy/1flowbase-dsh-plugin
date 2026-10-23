import { describe, expect, it } from 'vitest'
import { applicationSettings } from '../../src/application-settings.js'

describe('application protocol settings boundary', () => {
  it.each([undefined, {}])('keeps old imports on Chat: %j', value => {
    expect(applicationSettings(value)).toEqual({ protocol: 'chat-completions', remoteCompaction: true })
  })
  it('defaults remote Responses compaction on', () => {
    expect(applicationSettings({ protocol: 'responses' })).toEqual({ protocol: 'responses', remoteCompaction: true })
  })
  it.each([null, [], 'responses', { protocol: 'other' }, { remoteCompaction: 'true' }])('rejects invalid settings: %j', value => {
    expect(() => applicationSettings(value)).toThrow()
  })
})
