import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseReasoning } from './reasoning.js'
import { FlowbaseError } from './errors.js'
import type {
  AuthMode,
  FlowbaseInstanceRecord,
  ImportedApplication,
  PluginState,
  WireModel,
} from './shared/api.js'

const STATE_FILENAME = 'state.json'

/** Default durable state directory for this plugin. */
export function defaultStateDir(): string {
  return dshHomePath('1flowbase-dsh-plugin')
}

function initialState(): PluginState {
  return { version: 2, revision: 0, instances: [] }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new FlowbaseError('state/invalid', `state field ${field} must be a string`)
  return value
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return text(value, field)
}

function parseWireModels(value: unknown, field: string): WireModel[] {
  if (!Array.isArray(value)) throw new FlowbaseError('state/invalid', `state field ${field} must be an array`)
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new FlowbaseError('state/invalid', `state field ${field}[${String(index)}] must be an object`)
    }
    const raw = entry as Record<string, unknown>
    const name = optionalText(raw.name, `${field}[].name`)
    const id = text(raw.id, `${field}[].id`)
    return {
      id,
      name: name ?? id,
      contextWindow: Number(raw.contextWindow),
      maxTokens: Number(raw.maxTokens),
      ...parseReasoning(raw.reasoning),
    } satisfies WireModel
  })
}

/** Applications as version 2 stores them. */
function parseApplications(value: unknown): ImportedApplication[] {
  if (!Array.isArray(value)) throw new FlowbaseError('state/invalid', 'state instance applications must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new FlowbaseError('state/invalid', `state instance applications[${String(index)}] must be an object`)
    }
    const raw = entry as Record<string, unknown>
    return {
      applicationId: text(raw.applicationId, 'applications.applicationId'),
      name: text(raw.name, 'applications.name'),
      description: text(raw.description, 'applications.description'),
      apiKey: text(raw.apiKey, 'applications.apiKey'),
      models: parseWireModels(raw.models, `applications[${String(index)}].models`),
      importedAt: text(raw.importedAt, 'applications.importedAt'),
    } satisfies ImportedApplication
  })
}

/**
 * Version 1 kept exactly one wire model per import and used the application id
 * as the model id. Reading it as a one-entry catalogue keeps every existing
 * instance importable, and the next catalogue read fills in the rest.
 */
function migrateLegacyModels(value: unknown): ImportedApplication[] {
  if (!Array.isArray(value)) throw new FlowbaseError('state/invalid', 'state instance models must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new FlowbaseError('state/invalid', `state instance models[${String(index)}] must be an object`)
    }
    const raw = entry as Record<string, unknown>
    const wireModel = text(raw.wireModel, 'models.wireModel')
    return {
      applicationId: text(raw.applicationId, 'models.applicationId'),
      name: text(raw.name, 'models.name'),
      description: text(raw.description, 'models.description'),
      apiKey: text(raw.apiKey, 'models.apiKey'),
      models: [{
        id: wireModel,
        name: wireModel,
        contextWindow: Number(raw.contextWindow),
        maxTokens: Number(raw.maxTokens),
      }],
      importedAt: text(raw.importedAt, 'models.importedAt'),
    } satisfies ImportedApplication
  })
}

function parseInstance(value: unknown, version: 1 | 2): FlowbaseInstanceRecord {
  if (typeof value !== 'object' || value === null) {
    throw new FlowbaseError('state/invalid', 'state instance must be an object')
  }
  const raw = value as Record<string, unknown>
  const authMode = raw.authMode
  if (authMode !== 'api_key' && authMode !== 'login') {
    throw new FlowbaseError('state/invalid', 'state instance authMode is invalid')
  }
  const applications = version === 2 ? parseApplications(raw.applications) : migrateLegacyModels(raw.models)
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
    applications,
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
  if (raw.version !== 1 && raw.version !== 2) throw new FlowbaseError('state/invalid', 'unsupported state version')
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) {
    throw new FlowbaseError('state/invalid', 'state revision is invalid')
  }
  if (!Array.isArray(raw.instances)) throw new FlowbaseError('state/invalid', 'state instances must be an array')
  // Version 1 files are read through the legacy projection and written back as
  // version 2, so a downgrade is the only way to see the old shape again.
  const instances = raw.instances.map(entry => parseInstance(entry, raw.version as 1 | 2))
  const ids = new Set<string>()
  for (const instance of instances) {
    if (ids.has(instance.id)) throw new FlowbaseError('state/invalid', `duplicate instance id ${instance.id}`)
    ids.add(instance.id)
  }
  return { version: 2, revision: raw.revision as number, instances }
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
      applications: [],
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
