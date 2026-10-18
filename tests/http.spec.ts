import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpHandler } from '../src/http.js'
import { StateStore } from '../src/state.js'
import type { ModelRegistry } from '../src/models.js'
import type { McpRegistry } from '../src/mcp.js'
import type { ApplicationView } from '../src/shared/api.js'

const servers: ReturnType<typeof createServer>[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
  return `http://127.0.0.1:${String(address.port)}`
}

async function fixture(options: { rejectTokens?: readonly string[] } = {}): Promise<{
  baseUrl: string
  store: StateStore
  plugin: (path: string, init?: RequestInit) => Promise<Response>
  models: ModelRegistry
  mcps: McpRegistry
  mcpCalls: { enable: string[]; disable: string[] }
}> {
  const flowbase = await listen((req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /u, '')
    if (options.rejectTokens?.includes(token) === true) {
      json(res, 401, { error: { code: 'unauthorized', message: 'bad credential' } })
      return
    }
    if (req.url === '/api/console/applications') {
      json(res, 200, { data: [{ id: 'app-1', application_type: 'agent_flow', name: 'Support', description: 'desk' }] })
      return
    }
    if (req.url === '/api/console/mcp/catalog') {
      json(res, 200, { data: { instances: [] } })
      return
    }
    json(res, 404, { error: { code: 'not_found', message: 'missing' } })
  })
  const root = await mkdtemp(join(tmpdir(), '1flowbase-dsh-http-'))
  roots.push(root)
  const store = new StateStore(join(root, 'state'))
  await store.load()
  const apps: ApplicationView[] = [{
    id: 'app-1',
    name: 'Support',
    description: 'desk',
    imported: false,
    importedModel: null,
  }]
  const models = {
    listApplications: async () => apps,
    importApplication: async () => ({
      applicationId: 'app-1', name: 'Support', description: 'desk', wireModel: 'inner', contextWindow: 1, maxTokens: 1, importedAt: 'now',
    }),
    removeApplication: async () => undefined,
    refresh: () => undefined,
  } as unknown as ModelRegistry
  const mcpCalls = { enable: [] as string[], disable: [] as string[] }
  const mcps = {
    list: async () => [],
    enable: async (_instanceId: string, mcpInstanceId: string) => {
      mcpCalls.enable.push(mcpInstanceId)
      return { instanceId: mcpInstanceId, name: 'MCP', description: '', status: 'enabled', enabled: true, serverName: `MCP_${mcpInstanceId}`, enabledAt: 'now' }
    },
    disable: async (_instanceId: string, mcpInstanceId: string) => { mcpCalls.disable.push(mcpInstanceId) },
    removeInstance: async () => undefined,
  } as unknown as McpRegistry
  const handler = createHttpHandler({ store, models, mcps, timeoutMs: 5_000 })
  const pluginBase = await listen((req, res) => { void handler(req, res) })
  return {
    baseUrl: flowbase,
    store,
    models,
    mcps,
    mcpCalls,
    plugin: async (path, init) => await fetch(`${pluginBase}/api/1flowbase${path}`, init),
  }
}

describe('plugin HTTP API', () => {
  it('creates a verified instance and never returns its token', async () => {
    const { baseUrl, store, plugin } = await fixture()
    const response = await plugin('/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-1flowbase-request': '1' },
      body: JSON.stringify({ name: 'local', baseUrl, authMode: 'api_key', apiKey: 'user-secret' }),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { ok: boolean; data: { id: string; name: string } }
    expect(payload.ok).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('user-secret')

    const list = await plugin('/instances')
    const listed = await list.json() as { data: { id: string }[] }
    expect(listed.data).toHaveLength(1)
    expect(store.snapshot().instances[0]?.token).toBe('user-secret')
  })

  it('rejects a mutation without the plugin header and a cross-origin request', async () => {
    const { baseUrl, plugin } = await fixture()
    const missing = await plugin('/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'local', baseUrl, authMode: 'api_key', apiKey: 'x' }),
    })
    expect(missing.status).toBe(400)
    const crossOrigin = await plugin('/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-1flowbase-request': '1', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'local', baseUrl, authMode: 'api_key', apiKey: 'x' }),
    })
    expect(crossOrigin.status).toBe(400)
    const payload = await crossOrigin.json() as { error: { code: string } }
    expect(payload.error.code).toBe('request/forbidden-origin')
  })

  it('lists applications, imports one, and deletes the instance', async () => {
    const { baseUrl, store, plugin } = await fixture()
    const created = await plugin('/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-1flowbase-request': '1' },
      body: JSON.stringify({ name: 'local', baseUrl, authMode: 'api_key', apiKey: 'user-secret' }),
    })
    const { data } = await created.json() as { data: { id: string } }

    const apps = await (await plugin(`/instances/${data.id}/apps`)).json() as { data: ApplicationView[] }
    expect(apps.data[0]?.name).toBe('Support')

    const imported = await plugin(`/instances/${data.id}/apps/app-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-1flowbase-request': '1' },
      body: '{}',
    })
    expect(imported.status).toBe(200)

    const removed = await plugin(`/instances/${data.id}`, {
      method: 'DELETE',
      headers: { 'x-1flowbase-request': '1' },
    })
    expect(removed.status).toBe(200)
    expect(store.snapshot().instances).toHaveLength(0)
  })
})

function mutation(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-1flowbase-request': '1' },
    body: JSON.stringify(body),
  }
}

interface UpdatePayload {
  ok: boolean
  data?: {
    instance: { id: string; name: string; baseUrl: string; authMode: string; workspaceId: string | null; loginIdentifier: string | null }
    warnings: string[]
  }
  error?: { code: string; message: string }
}

/** Seed one login-mode instance carrying an enabled MCP, bypassing the sign-in flow. */
async function seedLoginInstance(store: StateStore, baseUrl: string): Promise<string> {
  const record = store.newInstance({
    name: 'local',
    baseUrl,
    authMode: 'login',
    token: 'user-secret',
    workspaceId: 'ws-1',
    loginIdentifier: 'root',
  })
  record.mcps.push({ mcpInstanceId: 'mcp-1', name: 'MCP one', serverName: 'MCP_one_mcp-1', enabledAt: 'then' })
  await store.update(draft => {
    draft.instances.push(record)
  })
  return record.id
}

describe('plugin HTTP API: instance updates', () => {
  it('renames an instance without touching its credential', async () => {
    const { baseUrl, store, plugin } = await fixture()
    const id = await seedLoginInstance(store, baseUrl)
    const revision = store.snapshot().revision

    const response = await plugin(`/instances/${id}/update`, mutation({ name: '  新名字  ' }))
    expect(response.status).toBe(200)
    const payload = await response.json() as UpdatePayload
    expect(payload.data?.instance.name).toBe('新名字')
    expect(payload.data?.warnings).toEqual([])

    const stored = store.snapshot().instances[0]
    expect(stored?.token).toBe('user-secret')
    expect(stored?.authMode).toBe('login')
    expect(stored?.loginIdentifier).toBe('root')
    expect(store.snapshot().revision).toBe(revision + 1)
  })

  it('rotates an API key, drops the login identity, and remounts enabled MCPs', async () => {
    const { baseUrl, store, plugin, mcpCalls } = await fixture()
    const id = await seedLoginInstance(store, baseUrl)

    const response = await plugin(`/instances/${id}/update`, mutation({
      credential: { authMode: 'api_key', apiKey: 'rotated-secret' },
    }))
    expect(response.status).toBe(200)
    const payload = await response.json() as UpdatePayload
    expect(payload.data?.instance.authMode).toBe('api_key')
    expect(payload.data?.instance.workspaceId).toBeNull()
    expect(payload.data?.instance.loginIdentifier).toBeNull()
    expect(payload.data?.warnings).toEqual([])
    expect(JSON.stringify(payload)).not.toContain('rotated-secret')

    const stored = store.snapshot().instances[0]
    expect(stored?.token).toBe('rotated-secret')
    expect(stored?.workspaceId).toBeNull()
    expect(mcpCalls.disable).toEqual(['mcp-1'])
    expect(mcpCalls.enable).toEqual(['mcp-1'])
  })

  it('verifies a new address and leaves state untouched when it is unreachable', async () => {
    const { baseUrl, store, plugin, mcpCalls } = await fixture()
    const id = await seedLoginInstance(store, baseUrl)

    const response = await plugin(`/instances/${id}/update`, mutation({ baseUrl: 'http://127.0.0.1:1' }))
    expect(response.status).toBe(502)
    expect(store.snapshot().instances[0]?.baseUrl).toBe(baseUrl)
    expect(mcpCalls.disable).toEqual([])
  })

  it('refuses a credential the deployment rejects and keeps the running one', async () => {
    const { baseUrl, store, plugin, mcpCalls } = await fixture({ rejectTokens: ['bad-key'] })
    const id = await seedLoginInstance(store, baseUrl)

    const response = await plugin(`/instances/${id}/update`, mutation({
      credential: { authMode: 'api_key', apiKey: 'bad-key' },
    }))
    expect(response.status).toBe(401)
    expect(store.snapshot().instances[0]?.token).toBe('user-secret')
    expect(mcpCalls.disable).toEqual([])
  })

  it('rejects an empty patch and an unknown instance', async () => {
    const { baseUrl, store, plugin } = await fixture()
    const id = await seedLoginInstance(store, baseUrl)

    const empty = await plugin(`/instances/${id}/update`, mutation({}))
    expect(empty.status).toBe(400)
    expect((await empty.json() as UpdatePayload).error?.code).toBe('request/invalid')

    const missing = await plugin('/instances/does-not-exist/update', mutation({ name: 'x' }))
    expect(missing.status).toBe(404)
  })

  it('rejects a login credential without a password', async () => {
    const { baseUrl, store, plugin } = await fixture()
    const id = await seedLoginInstance(store, baseUrl)

    const response = await plugin(`/instances/${id}/update`, mutation({
      credential: { authMode: 'login', identifier: 'root' },
    }))
    expect(response.status).toBe(400)
    expect(store.snapshot().instances[0]?.token).toBe('user-secret')
  })
})
