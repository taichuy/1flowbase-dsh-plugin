import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ModelRegistry, providerIdFor } from '../src/models.js'
import { StateStore } from '../src/state.js'
import type { FlowbaseLlmAdapter } from '../src/adapter.js'

const servers: ReturnType<typeof createServer>[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface CatalogueModel {
  id: string
  name?: string
  reasoning?: unknown
  context_window?: number
  max_output_tokens?: number
}

interface Upstream {
  baseUrl: string
  setCatalogue(applicationKey: string, models: readonly CatalogueModel[]): void
  failCatalogues(value: boolean): void
  pauseCatalogue(): { started: Promise<void>; release(): void }
}

function json(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function upstream(): Promise<Upstream> {
  const catalogues = new Map<string, readonly CatalogueModel[]>([
    ['key-app-1', [{ id: 'claude-opus-5-5', context_window: 256 }]],
    ['key-app-2', [{ id: 'claude-4-5', context_window: 128_000 }]],
  ])
  let fail = false
  let pause: { start(): void; done: Promise<void> } | undefined
  const applications = [
    { id: 'app-1', application_type: 'agent_flow', name: '1flowbase', description: 'wrapped models' },
    { id: 'app-2', application_type: 'agent_flow', name: 'codex', description: '' },
    { id: 'app-3', application_type: 'chat', name: 'plain', description: 'not an agent flow' },
  ]
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    if (path === '/api/console/applications') {
      json(res, { data: applications })
      return
    }
    if (/^\/api\/console\/applications\/[^/]+\/api-keys$/u.test(path)) {
      json(res, { data: { token: `key-${path.split('/')[4] ?? ''}` } })
      return
    }
    if (path === '/v1/models') {
      if (pause) { pause.start(); await pause.done; pause = undefined }
      if (fail) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'catalogue unavailable' } }))
        return
      }
      const key = (req.headers.authorization ?? '').replace(/^Bearer /u, '')
      json(res, { data: catalogues.get(key) ?? [] })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'not_found', message: path } }))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    setCatalogue: (applicationKey, models) => { catalogues.set(applicationKey, models) },
    failCatalogues: value => { fail = value },
    pauseCatalogue: () => {
      let start!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => { start = resolve })
      const done = new Promise<void>(resolve => { release = resolve })
      pause = { start, done }
      return { started, release }
    },
  }
}

interface Registration {
  routes: readonly string[]
  adapter: FlowbaseLlmAdapter
}

async function fixture(): Promise<{
  id: string
  store: StateStore
  registry: ModelRegistry
  upstream: Upstream
  registrations: Registration[]
}> {
  const flowbase = await upstream()
  const root = await mkdtemp(join(tmpdir(), '1flowbase-dsh-models-'))
  roots.push(root)
  const store = new StateStore(join(root, 'state'))
  await store.load()
  const record = store.newInstance({
    name: 'gateway',
    baseUrl: flowbase.baseUrl,
    authMode: 'api_key',
    token: 'user-secret',
    workspaceId: null,
    loginIdentifier: null,
  })
  await store.update(draft => {
    draft.instances.push(record)
  })
  const registrations: Registration[] = []
  const ctx = {
    llm: {
      registerAdapter: (routes: readonly string[], adapter: FlowbaseLlmAdapter) => {
        registrations.push({ routes: [...routes], adapter })
        return Object.assign(() => undefined, {
          replace: (next: readonly string[]) => { registrations.push({ routes: [...next], adapter }) },
        })
      },
    },
  } as unknown as Context
  return { id: record.id, store, registry: new ModelRegistry(ctx, store, 5_000), upstream: flowbase, registrations }
}

describe('provider ids', () => {
  it('derive from the instance and application, never from a display name', () => {
    expect(providerIdFor('8f14e45f-ceea-367a-9a36-1b1a3d1c4e2b', '01a08968-5ea8-7e63-b70e-3fd5bd9522b4'))
      .toBe('fb_8f14e45fceea367a9a361b1a3d1c4e2b_01a089685ea87e63b70e3fd5bd9522b4')
    expect(providerIdFor('a b/c', 'x-y')).toBe('fb_abc_xy')
  })
})

describe('ModelRegistry', () => {
  it('preserves saved settings when an older catalogue refresh completes', async () => {
    const { id, store, registry, upstream } = await fixture()
    try {
      await registry.importApplication(id, 'app-1')
      upstream.setCatalogue('key-app-1', [{ id: 'new-model' }])
      const gate = upstream.pauseCatalogue()
      const pending = registry.listApplications(id)
      await gate.started
      await registry.updateApplication(id, 'app-1', { protocol: 'anthropic-messages', remoteCompaction: false })
      gate.release()
      const views = await pending
      expect(store.require(id).applications[0]).toMatchObject({ protocol: 'anthropic-messages', remoteCompaction: false, models: [{ id: 'new-model' }] })
      expect(views.find(view => view.id === 'app-1')?.importedApplication).toMatchObject({ protocol: 'anthropic-messages', remoteCompaction: false })
    } finally { registry.dispose() }
  })

  it('edits protocol for every application model without changing its key or identity', async () => {
    const { id, store, registry, registrations } = await fixture()
    const imported = await registry.importApplication(id, 'app-1', { protocol: 'responses', remoteCompaction: true })
    expect(imported).toMatchObject({ protocol: 'responses', remoteCompaction: true })
    const before = store.require(id).applications[0]!
    const provider = providerIdFor(id, 'app-1')
    expect(registry.resolveRoute(provider, before.models[0]!.id)?.protocol).toBe('responses')
    const edited = await registry.updateApplication(id, 'app-1', { protocol: 'anthropic-messages', remoteCompaction: false })
    expect(edited).toMatchObject({ protocol: 'anthropic-messages', remoteCompaction: false })
    expect(store.require(id).applications[0]).toMatchObject({ apiKey: before.apiKey, importedAt: before.importedAt, models: before.models })
    expect(registry.resolveRoute(provider, before.models[0]!.id)?.protocol).toBe('anthropic-messages')
    expect(registrations.at(-1)?.routes).toEqual([provider])
    const reloaded = new StateStore(store.directory)
    await reloaded.load()
    expect(reloaded.require(id).applications[0]).toMatchObject({ protocol: 'anthropic-messages', remoteCompaction: false })
  })

  it('imports an application as one provider carrying its whole catalogue', async () => {
    const { id, store, registry, upstream: flowbase, registrations } = await fixture()
    flowbase.setCatalogue('key-app-1', [
      { id: 'claude-opus-5-5', context_window: 256 },
      { id: 'gpt-5.6-sol', context_window: 256_000, max_output_tokens: 16_384 },
    ])

    const imported = await registry.importApplication(id, 'app-1')
    expect(imported.models.map(model => model.id)).toEqual(['claude-opus-5-5', 'gpt-5.6-sol'])
    expect(store.require(id).applications[0]?.models).toHaveLength(2)

    const provider = providerIdFor(id, 'app-1')
    expect(registrations.at(-1)?.routes).toEqual([provider])
    const adapter = registrations.at(-1)?.adapter
    expect(adapter?.providerInfo(provider)).toEqual({ id: provider, name: '1flowbase' })
    await expect(adapter?.listModels(provider)).resolves.toEqual([
      { provider, id: 'claude-opus-5-5', name: 'claude-opus-5-5', description: 'wrapped models' },
      { provider, id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', description: 'wrapped models' },
    ])
  })

  it('imports, persists and refreshes reasoning metadata without changing model ids', async () => {
    const { id, store, registry, upstream: flowbase, registrations } = await fixture()
    const reasoning = { supported_efforts: ['low', 'high', 'custom-v2'], default_effort: 'high' }
    flowbase.setCatalogue('key-app-1', [{ id: 'inner', reasoning }, { id: 'plain' }])
    const imported = await registry.importApplication(id, 'app-1')
    expect(imported.models[0]?.reasoning).toEqual(reasoning)
    expect(imported.models[1]).not.toHaveProperty('reasoning')
    const reloaded = new StateStore(store.directory)
    await reloaded.load()
    expect(reloaded.require(id).applications[0]?.models[0]?.reasoning).toEqual(reasoning)
    const adapter = registrations.at(-1)!.adapter
    const provider = providerIdFor(id, 'app-1')
    const projected = { efforts: reasoning.supported_efforts.map(id => ({ id, name: id })), defaultEffort: 'high' }
    expect((await adapter.listModels(provider))[0]?.reasoning).toEqual(projected)
    expect((await adapter.resolveModel(provider, 'inner')).reasoning).toEqual(projected)
    expect((await adapter.resolveModel(provider, 'plain')).reasoning).toBeUndefined()

    // Only the capability changes: comparison must not ignore it.
    const changed = { supported_efforts: ['low', 'custom-v2'], default_effort: 'custom-v2' }
    flowbase.setCatalogue('key-app-1', [{ id: 'inner', reasoning: changed }, { id: 'plain' }])
    const beforeRefresh = registrations.length
    await registry.listApplications(id)
    expect(registrations).toHaveLength(beforeRefresh + 1)
    expect(store.require(id).applications[0]?.models[0]?.reasoning).toEqual(changed)
    expect((await adapter.resolveModel(provider, 'inner')).reasoning?.defaultEffort).toBe('custom-v2')
    flowbase.failCatalogues(true)
    await registry.reconcileAll()
    expect(store.require(id).applications[0]?.models[0]?.reasoning).toEqual(changed)
    flowbase.failCatalogues(false)
    flowbase.setCatalogue('key-app-1', [{ id: 'inner' }, { id: 'plain' }])
    await registry.reconcileAll()
    expect((await adapter.resolveModel(provider, 'inner')).reasoning).toBeUndefined()
  })

  it('upgrades an existing import with effort metadata on boot reconciliation', async () => {
    const { id, registry, store, upstream: flowbase } = await fixture()
    await registry.importApplication(id, 'app-1')
    const reasoning = { supported_efforts: ['max'] }
    flowbase.setCatalogue('key-app-1', [{ id: 'claude-opus-5-5', context_window: 256, reasoning }])
    await registry.reconcileAll()
    expect(store.require(id).applications[0]?.models[0]?.reasoning).toEqual(reasoning)
  })

  it('registers one provider per imported application', async () => {
    const { id, registry, registrations } = await fixture()
    await registry.importApplication(id, 'app-1')
    await registry.importApplication(id, 'app-2')
    expect(registrations.at(-1)?.routes).toEqual([
      providerIdFor(id, 'app-1'),
      providerIdFor(id, 'app-2'),
    ])
  })

  it('refuses an application the credential cannot see as an agent flow', async () => {
    const { id, registry } = await fixture()
    await expect(registry.importApplication(id, 'app-3')).rejects.toMatchObject({ code: 'application/not-found' })
  })

  it('refreshes imported catalogues when the application list is read', async () => {
    const { id, store, registry, upstream: flowbase } = await fixture()
    await registry.importApplication(id, 'app-1')
    expect(store.require(id).applications[0]?.models.map(model => model.id)).toEqual(['claude-opus-5-5'])

    // The application publishes another model; the local copy follows it.
    flowbase.setCatalogue('key-app-1', [
      { id: 'claude-opus-5-5', context_window: 256 },
      { id: 'deepseek-flash', context_window: 1_000_000, max_output_tokens: 384_000 },
    ])
    const applications = await registry.listApplications(id)
    const imported = applications.find(application => application.id === 'app-1')
    expect(imported?.importedApplication?.models.map(model => model.id)).toEqual(['claude-opus-5-5', 'deepseek-flash'])
    expect(store.require(id).applications[0]?.models[1]?.contextWindow).toBe(1_000_000)
  })

  it('keeps the stored catalogue when the application cannot be read', async () => {
    const { id, store, registry, upstream: flowbase } = await fixture()
    flowbase.setCatalogue('key-app-1', [
      { id: 'claude-opus-5-5', context_window: 256 },
      { id: 'gpt-5.6-sol', context_window: 256_000 },
    ])
    await registry.importApplication(id, 'app-1')

    flowbase.failCatalogues(true)
    const applications = await registry.listApplications(id)
    expect(applications.find(application => application.id === 'app-1')?.importedApplication?.models)
      .toHaveLength(2)
    expect(store.require(id).applications[0]?.models).toHaveLength(2)
  })

  it('reconciles imported catalogues at boot, without opening a settings page', async () => {
    const { id, store, registry, upstream: flowbase } = await fixture()
    await registry.importApplication(id, 'app-1')
    expect(store.require(id).applications[0]?.models).toHaveLength(1)

    flowbase.setCatalogue('key-app-1', [
      { id: 'claude-opus-5-5', context_window: 256 },
      { id: 'gemini-3.8-flash', context_window: 256_000 },
    ])
    await registry.reconcileAll()
    expect(store.require(id).applications[0]?.models.map(model => model.id))
      .toEqual(['claude-opus-5-5', 'gemini-3.8-flash'])
  })

  it('keeps booting when an instance catalogue cannot be read', async () => {
    const { id, store, registry, upstream: flowbase } = await fixture()
    await registry.importApplication(id, 'app-1')
    flowbase.failCatalogues(true)
    await expect(registry.reconcileAll()).resolves.toBeUndefined()
    expect(store.require(id).applications[0]?.models.map(model => model.id)).toEqual(['claude-opus-5-5'])
  })

  it('unregisters the provider when the application is removed', async () => {
    const { id, registry, registrations } = await fixture()
    await registry.importApplication(id, 'app-1')
    await registry.removeApplication(id, 'app-1')
    expect(registrations.at(-1)?.routes).toEqual([])
  })
})
