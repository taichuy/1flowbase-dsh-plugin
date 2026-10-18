import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../src/state.js'

const roots: string[] = []

async function fixture(): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), '1flowbase-dsh-state-'))
  roots.push(root)
  return { root, store: new StateStore(join(root, 'state')) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('StateStore', () => {
  it('starts empty, persists an instance atomically, and reloads it', async () => {
    const { store } = await fixture()
    const loaded = await store.load()
    expect(loaded).toEqual({ version: 1, revision: 0, instances: [] })

    const record = store.newInstance({
      name: 'local',
      baseUrl: 'http://127.0.0.1:7800',
      authMode: 'api_key',
      token: 'secret-token',
      workspaceId: 'ws-1',
      loginIdentifier: null,
    })
    await store.update(draft => { draft.instances.push(record) })

    const reloaded = new StateStore(store.directory)
    const state = await reloaded.load()
    expect(state.revision).toBe(1)
    expect(state.instances).toHaveLength(1)
    expect(state.instances[0]?.token).toBe('secret-token')
    expect(reloaded.require(record.id).name).toBe('local')

    const mode = (await stat(store.file)).mode & 0o777
    expect(mode).toBe(0o600)
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toMatchObject({ version: 1, revision: 1 })
  })

  it('serializes concurrent updates without losing writes', async () => {
    const { store } = await fixture()
    await store.load()
    await Promise.all(Array.from({ length: 5 }, (_, index) => store.update(draft => {
      const record = store.newInstance({
        name: `instance-${String(index)}`,
        baseUrl: 'http://127.0.0.1:7800',
        authMode: 'api_key',
        token: `token-${String(index)}`,
        workspaceId: null,
        loginIdentifier: null,
      })
      draft.instances.push(record)
    })))
    const state = await store.load()
    expect(state.instances).toHaveLength(5)
    expect(state.revision).toBe(5)
  })

  it('fails loud on corrupt state instead of replacing it', async () => {
    const { root, store } = await fixture()
    await store.load()
    await mkdir(store.directory, { recursive: true })
    await writeFile(store.file, '{"version":99}', 'utf8')
    const corrupt = new StateStore(join(root, 'state'))
    await expect(corrupt.load()).rejects.toMatchObject({ code: 'state/invalid' })
  })

  it('refuses an unknown instance id', async () => {
    const { store } = await fixture()
    await store.load()
    expect(() => store.require('missing')).toThrowError(/unknown 1flowbase instance/u)
  })
})
