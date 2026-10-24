import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AdapterModel } from '../../src/adapter.js'
import { responseHeaders, responseMetadata } from '../../src/protocols/metadata.js'
const entry = { baseUrl: 'https://gateway.example', applicationKey: 'private-key', wireModel: 'model' } as AdapterModel
const options = { provider: 'p', model: 'model', sessionId: '/private/session', messages: [] } as GenerateOptions

describe('Responses client identity and affinity', () => {
  it('keeps opaque affinity stable while giving each request a fresh correlation id', () => {
    const first = responseHeaders(entry, options)
    const second = responseHeaders(entry, options)
    expect(first.session_id).toMatch(/^[a-f0-9]{64}$/u)
    expect(second.session_id).toBe(first.session_id)
    expect(second['x-client-request-id']).not.toBe(first['x-client-request-id'])
    expect(first['user-agent']).toMatch(/^deepseek-harness\/[^ ]+ \(.+; .+\)/u)
    expect(first.authorization).toBe('Bearer private-key')
    expect(responseMetadata(entry, options)).toEqual({ prompt_cache_key: first.session_id })
    expect(JSON.stringify(responseMetadata(entry, options))).not.toContain('private')
  })
  it('isolates sessions, providers, models and endpoints without using API keys as identity', () => {
    const key = responseMetadata(entry, options).prompt_cache_key
    expect(responseMetadata({ ...entry, applicationKey: 'rotated' }, options).prompt_cache_key).toBe(key)
    for (const next of [{ ...options, sessionId: 'other' }, { ...options, provider: 'other' }]) {
      expect(responseMetadata(entry, next as GenerateOptions).prompt_cache_key).not.toBe(key)
    }
    expect(responseMetadata({ ...entry, wireModel: 'other' }, options).prompt_cache_key).not.toBe(key)
    expect(responseMetadata({ ...entry, baseUrl: 'https://other.example' }, options).prompt_cache_key).not.toBe(key)
  })
  it('does not give auxiliary or sessionless calls conversation affinity', () => {
    for (const request of [{ ...options, purpose: 'compaction' }, { provider: 'p', model: 'model', messages: [] }]) {
      expect(responseMetadata(entry, request as GenerateOptions)).toEqual({})
      expect(responseHeaders(entry, request as GenerateOptions)).not.toHaveProperty('session_id')
    }
  })
})
