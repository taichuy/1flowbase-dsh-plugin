import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { FlowbaseError } from './errors.js'
import type { AuthMode, FlowbaseInstanceRecord, PluginState } from './shared/api.js'

const STATE_FILENAME = 'state.json'

/** Default durable state directory for this plugin. */
export function defaultStateDir(): string {
  return dshHomePath('1flowbase-dsh-plugin')
}

function initialState(): PluginState {
  return { version: 1, revision: 0, instances: [] }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new FlowbaseError('state/invalid', `state field ${field} must be a string`)
  return value
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return text(value, field)
}

function parseInstance(value: unknown): FlowbaseInstanceRecord {
  if (typeof value !== 'object' || value === null) {
    throw new FlowbaseError('state/invalid', 'state instance must be an object')
  }
  const raw = value as Record<string, unknown>
  const authMode = raw.authMode
  if (authMode !== 'api_key' && authMode !== 'login') {
    throw new FlowbaseError('state/invalid', 'state instance authMode is invalid')
  }
  const models = Array.isArray(raw.models)
    ? raw.models.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new FlowbaseError('state/invalid', `state instance models[${String(index)}] must be an object`)
      }
      const model = entry as Record<string, unknown>
      return {
        applicationId: text(model.applicationId, 'models.applicationId'),
        name: text(model.name, 'models.name'),
        description: text(model.description, 'models.description'),
        wireModel: text(model.wireModel, 'models.wireModel'),
        apiKey: text(model.apiKey, 'models.apiKey'),
        contextWindow: Number(model.contextWindow),
        maxTokens: Number(model.maxTokens),
        importedAt: text(model.importedAt, 'models.importedAt'),
      }
    })
    : []
  const mcps = Array.isArray(raw.mcps)
    ? raw.mcps.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new FlowbaseError('state/invalid', `state instance mcps[${String(index)}] must be an object`)
      }
      const mcp = entry as Record<string, unknown>
      return {
        mcpInstanceId: text(mcp.mcpInstanceId, 'mcps.mcpInstanceId'),
        name: text(mcp.name, 'mcps.name'),
        serverName: text(mcp.serverName, 'mcps.serverName'),
        enabledAt: text(mcp.enabledAt, 'mcps.enabledAt'),
      }
    })
    : []
  return {
    id: text(raw.id, 'id'),
    name: text(raw.name, 'name'),
    baseUrl: text(raw.baseUrl, 'baseUrl'),
    authMode: authMode satisfies AuthMode,
    token: text(raw.token, 'token'),
    workspaceId: optionalText(raw.workspaceId, 'workspaceId'),
    loginIdentifier: optionalText(raw.loginIdentifier, 'loginIdentifier'),
    models,
    mcps,
    createdAt: text(raw.createdAt, 'createdAt'),
    updatedAt: text(raw.updatedAt, 'updatedAt'),
  }
}

function parseState(value: unknown): PluginState {
  if (typeof value !== 'object' || value === null) {
    throw new FlowbaseError('state/invalid', 'state must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) throw new FlowbaseError('state/invalid', 'unsupported state version')
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) {
    throw new FlowbaseError('state/invalid', 'state revision is invalid')
  }
  if (!Array.isArray(raw.instances)) throw new FlowbaseError('state/invalid', 'state instances must be an array')
  const instances = raw.instances.map(parseInstance)
  const ids = new Set<string>()
  for (const instance of instances) {
    if (ids.has(instance.id)) throw new FlowbaseError('state/invalid', `duplicate instance id ${instance.id}`)
    ids.add(instance.id)
  }
  return { version: 1, revision: raw.revision as number, instances }
}

/** Atomically persisted instance state; the file is owner-only. */
export class StateStore {
  readonly file: string
  private state: PluginState = initialState()
  private queue: Promise<unknown> = Promise.resolve()
  private loaded = false

  constructor(readonly directory = defaultStateDir()) {
    this.file = join(directory, STATE_FILENAME)
  }

  /** Read the state once; a missing file starts empty and a corrupt file fails loud. */
  async load(): Promise<PluginState> {
    if (this.loaded) return this.snapshot()
    try {
      const content = await readFile(this.file, 'utf8')
      this.state = parseState(JSON.parse(content) as unknown)
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof FlowbaseError) throw error
        throw new FlowbaseError('state/invalid', `cannot read 1flowbase plugin state: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error })
      }
      this.state = initialState()
    }
    this.loaded = true
    return this.snapshot()
  }

  /** Detached copy for callers that render or resolve without writing. */
  snapshot(): PluginState {
    return structuredClone(this.state)
  }

  /** Find one instance by id, or fail with a stable code. */
  require(id: string): FlowbaseInstanceRecord {
    const instance = this.state.instances.find(entry => entry.id === id)
    if (instance === undefined) throw new FlowbaseError('instance/not-found', `unknown 1flowbase instance ${id}`)
    return structuredClone(instance)
  }

  /** Serialize a mutation, persist it atomically, and return the mutator result. */
  async update<T>(mutator: (draft: PluginState) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = this.snapshot()
      const result = await mutator(draft)
      draft.revision += 1
      await this.write(draft)
      this.state = draft
      return result
    })
    this.queue = run.then(() => undefined, () => undefined)
    return await run
  }

  /** Create one instance record with a fresh id. */
  newInstance(input: {
    name: string
    baseUrl: string
    authMode: AuthMode
    token: string
    workspaceId: string | null
    loginIdentifier: string | null
  }): FlowbaseInstanceRecord {
    const now = new Date().toISOString()
    return {
      id: randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl,
      authMode: input.authMode,
      token: input.token,
      workspaceId: input.workspaceId,
      loginIdentifier: input.loginIdentifier,
      models: [],
      mcps: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  private async write(state: PluginState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${String(process.pid)}.${String(Date.now())}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.file)
      await chmod(this.file, 0o600)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw new FlowbaseError('state/write-failed', `cannot persist 1flowbase plugin state: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error })
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
