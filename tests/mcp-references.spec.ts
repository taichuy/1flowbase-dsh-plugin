// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpReferenceSource } from '../src/client/mcp-references.js'
import type { McpReference } from '../src/shared/api.js'
import type { InputTriggerPick, ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

const session = { sessionId: 'session' } as ClientSessionContext
const items: McpReference[] = [
  { instanceId: 'a', instanceName: '生产', mcpInstanceId: 'm', name: '客服', serverName: 'support_a' },
  { instanceId: 'b', instanceName: '测试', mcpInstanceId: 'm', name: '客服', serverName: 'support_b' },
]
const request = (query = '') => ({ query, quoted: false, position: 'inline' as const, drilled: false, signal: new AbortController().signal })
afterEach(() => vi.unstubAllGlobals())

describe('native MCP reference source', () => {
  it('queries enabled connectors, distinguishes duplicate names, and serializes the current namespace', async () => {
    let enabled = items
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: enabled })))
    vi.stubGlobal('fetch', fetch)
    const source = mcpReferenceSource()
    expect(source.trigger).toBe('@')
    const rows = await source.candidates(session, request('客服'))
    expect(rows.map(row => row.label)).toEqual(['客服 · 生产', '客服 · 测试'])
    expect((await source.candidates(session, request('support_b'))).map(row => row.name)).toEqual(['support_b'])
    expect((await source.candidates(session, request('生产'))).map(row => row.name)).toEqual(['support_a'])
    const outcome = source.onPick({ candidate: rows[0] } as InputTriggerPick)
    expect(outcome).toHaveProperty('insert.source', source.name)
    if (outcome === undefined || !('insert' in outcome)) throw new Error('missing reference chip')
    expect(source.codec!.clipboardText(outcome.insert.ref)).toBe('@support_a')
    // Renames/reconnections are resolved against current Host state at send time.
    enabled = [{ ...items[0]!, serverName: 'new_support' }]
    const text = await source.codec!.serialize(outcome.insert.ref, request().signal)
    expect(text).toContain('mcp__new_support__*')
    expect(text).toContain('客服')
    expect(text).not.toContain('support_a')
    enabled = []
    expect(await source.candidates(session, request())).toEqual([])
    await expect(source.codec!.serialize(outcome.insert.ref, request().signal)).rejects.toThrow(/disabled|停用/)
    expect(fetch).toHaveBeenCalledWith('/api/1flowbase/mcp-references', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('does not interfere with quoted file lookup and propagates cancellation', async () => {
    const fetch = vi.fn(async (_url, init) => { init.signal.throwIfAborted(); return new Response() })
    vi.stubGlobal('fetch', fetch)
    const source = mcpReferenceSource()
    expect(await source.candidates(session, { ...request(), quoted: true })).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    await expect(source.candidates(session, { ...request(), signal: controller.signal })).rejects.toThrow()
  })
})
