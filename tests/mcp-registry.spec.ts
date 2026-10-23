import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { McpRegistry } from '../src/mcp.js'
import { StateStore } from '../src/state.js'

vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => ({ resolve: () => new URL('./fixtures/mcp-client.js', import.meta.url).pathname }),
}))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('offers only committed mounted MCPs and removes them on disable/disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-references-'))
  roots.push(root)
  const store = new StateStore(root)
  await store.load()
  const instance = store.newInstance({ name: 'Gateway', baseUrl: 'http://localhost', authMode: 'api_key', token: 'secret', workspaceId: null, loginIdentifier: null })
  instance.mcps = [{ mcpInstanceId: 'm', name: 'MCP', serverName: 'mcp_test', enabledAt: 'now' }]
  await store.update(draft => { draft.instances.push(instance) })
  const dispose = vi.fn()
  const ctx = { plugin: () => Object.assign(Promise.resolve(), { dispose }), logger: () => ({ warn: vi.fn() }) } as unknown as Context
  const registry = new McpRegistry(ctx, store, 1000)
  expect(registry.references()).toEqual([])
  await registry.restore()
  expect(registry.references()).toEqual([{ instanceId: instance.id, instanceName: 'Gateway', mcpInstanceId: 'm', name: 'MCP', serverName: 'mcp_test' }])
  expect(JSON.stringify(registry.references())).not.toContain('secret')
  await registry.disable(instance.id, 'm')
  expect(registry.references()).toEqual([])
  expect(dispose).toHaveBeenCalledOnce()
  await store.update(draft => { draft.instances[0]!.mcps = instance.mcps })
  await registry.restore()
  expect(registry.references()).toHaveLength(1)
  await registry.dispose()
  expect(registry.references()).toEqual([])
})

it('does not offer a connector whose startup failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-failed-'))
  roots.push(root)
  const store = new StateStore(root)
  await store.load()
  const instance = store.newInstance({ name: 'Gateway', baseUrl: 'http://localhost', authMode: 'api_key', token: 'secret', workspaceId: null, loginIdentifier: null })
  instance.mcps = [{ mcpInstanceId: 'm', name: 'MCP', serverName: 'mcp_test', enabledAt: 'now' }]
  await store.update(draft => { draft.instances.push(instance) })
  const ctx = { plugin: () => { throw new Error('unavailable') }, logger: () => ({ warn: vi.fn() }) } as unknown as Context
  const registry = new McpRegistry(ctx, store, 1000)
  await registry.restore()
  expect(registry.references()).toEqual([])
})
