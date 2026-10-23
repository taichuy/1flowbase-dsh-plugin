import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { hostModule } from './host.js'
import { compactResponses } from '../../src/protocols/responses.js'
import { responsesInput } from '../../src/protocols/responses-request.js'
import type { AdapterModel } from '../../src/adapter.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

vi.mock('../../src/host-module.js', async () => {
  const { hostModule } = await import('./host.js')
  return { loadHostModule: hostModule }
})

describe('native compaction transaction and durable restore', () => {
  it.each(['success', 'failure', 'cancel'] as const)('%s preserves a replayable session after disk restore', async mode => {
    const { Context } = await hostModule('@deepseek-ai/cordis')
    const { Session } = await hostModule('@deepseek-ai/dsh-session')
    const { createUserMessage } = await hostModule('@deepseek-ai/dsh-llm')
    const { TokenMeter } = await hostModule('@deepseek-ai/dsh-token-meter')
    const { validateStoredEvents } = await hostModule('@deepseek-ai/dsh-session-persistence')
    const { default: Engine } = await import('../../src/compaction.js')
    const directory = await mkdtemp(join(tmpdir(), 'flowbase-compact-'))
    const path = join(directory, 'session.json')
    const ctx = new Context()
    ctx.provide('sessionProjections', { register: () => () => {} })
    new TokenMeter(ctx)
    ctx.provide('sessions', {
      // Real engine checkpoint with disk I/O; this does not claim JSONL-backend coverage.
      flush: async (session: any) => writeFile(path, JSON.stringify({ header: session.header, events: session.snapshotEvents() })),
    })
    const controller = new AbortController()
    const native = [{ type: 'compaction', encrypted_content: 'opaque+/=\noriginal', extension: { retained: true } }]
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume the real compact request. */ }
      if (mode === 'cancel') {
        controller.abort(new Error('fixture cancelled compaction'))
        response.end()
        return
      }
      response.writeHead(mode === 'failure' ? 500 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(mode === 'failure' ? { error: 'upstream failed' } : { output: native }))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('fixture did not bind')
    const route = { baseUrl: `http://127.0.0.1:${address.port}`, applicationKey: 'fixture', wireModel: 'model' } as AdapterModel
    ctx.provide('flowbaseProtocols', {
      resolveRoute: () => ({ protocol: 'responses', remoteCompaction: true }),
      compact: (options: GenerateOptions) => compactResponses(route, options),
    })
    // Installed host runtime exposes methods beyond the plugin's structural hook declaration.
    const engine: any = new Engine(ctx, { auto: false })
    const session = new Session(`fixture-${mode}`)
    for (const text of ['original '.repeat(1000), 'retained tail']) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const originalNodes = [...session.surface.nodes]
    const messagesOf = (owner: any) => owner.surface.nodes.map((seq: any) => owner.deriveEventMessage(owner.eventAt(seq))).filter(Boolean)
    const originalInput = responsesInput({ provider: 'provider', model: 'model', messages: messagesOf(session) })
    const agent = { session, options: { provider: 'provider', model: 'model' }, runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal) }
    try {
      const transaction = engine.compactNow(agent, controller.signal)
      if (mode === 'success') {
        expect(await transaction).not.toBeNull()
        expect(session.surface.nodes).not.toEqual(originalNodes)
      } else {
        await expect(transaction).rejects.toThrow()
        expect(session.surface.nodes).toEqual(originalNodes)
      }
      const saved = JSON.parse(await readFile(path, 'utf8'))
      const events = validateStoredEvents(saved.header, saved.events)
      const restored = Session.fromRestore(session.id, events, saved.header, 0, 'validated')
      const input = responsesInput({ provider: 'provider', model: 'model', messages: messagesOf(restored) })
      expect(events.filter((event: any) => event.type === 'compaction/start')).toHaveLength(1)
      expect(events.filter((event: any) => event.type === 'compaction/end')).toHaveLength(1)
      if (mode === 'success') {
        expect(input.filter(item => item.type === 'compaction')).toEqual(native)
        expect(JSON.stringify(input)).not.toContain('compacted-summary')
        expect(JSON.stringify(input)).not.toContain('original original')
        expect(events.filter((event: any) => event.type === 'compaction/summary')).toHaveLength(1)
      } else {
        expect(input).toEqual(originalInput)
        expect(events.filter((event: any) => event.type === 'compaction/summary')).toHaveLength(0)
      }
    } finally {
      await ctx.fiber.dispose()
      upstream.closeAllConnections()
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
})
