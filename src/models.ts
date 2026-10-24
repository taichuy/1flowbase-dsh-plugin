import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { FlowbaseClient } from './flowbase.js'
import type { FlowbaseApplication, FlowbaseAppModel } from './flowbase.js'
import { FlowbaseError } from './errors.js'
import type { AdapterModel, AdapterSnapshot } from './adapter.js'
import { parseReasoning } from './reasoning.js'
import { FlowbaseLlmAdapter } from './adapter.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ResponsesTransportOptions } from './protocols/responses-transport.js'
import type { StateStore } from './state.js'
import type {
  ApplicationView,
  ApplicationProtocolSettings,
  FlowbaseInstanceRecord,
  ImportedApplication,
  ImportedApplicationView,
  WireModel,
} from './shared/api.js'

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 32_768

/**
 * Route id for one imported application. An application publishes its own
 * catalogue and carries its own key, so it is the provider; the id derives
 * from the instance and application it came from, never from a renameable
 * display name.
 */
export function providerIdFor(instanceId: string, applicationId: string): string {
  return `fb_${sanitize(instanceId)}_${sanitize(applicationId)}`
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, '')
}

/** Project one application's `/v1/models` catalogue into stored wire models. */
function wireModelsOf(catalogue: readonly FlowbaseAppModel[]): WireModel[] {
  return catalogue.map(model => ({
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: positive(model.context_window ?? model.limit?.context, DEFAULT_CONTEXT_WINDOW),
    maxTokens: positive(model.max_output_tokens ?? model.limit?.output, DEFAULT_MAX_TOKENS),
    ...parseReasoning(model.reasoning),
  }))
}

function sameCatalogue(left: readonly WireModel[], right: readonly WireModel[]): boolean {
  return left.length === right.length && left.every((model, index) => {
    const other = right[index]
    return other !== undefined
      && other.id === model.id
      && other.name === model.name
      && other.contextWindow === model.contextWindow
      && other.maxTokens === model.maxTokens
      && JSON.stringify(other.reasoning) === JSON.stringify(model.reasoning)
  })
}

function applicationView(application: ImportedApplication): ImportedApplicationView {
  return {
    protocol: application.protocol,
    remoteCompaction: application.remoteCompaction,
    applicationId: application.applicationId,
    name: application.name,
    description: application.description,
    models: application.models.map(model => ({ ...model })),
    importedAt: application.importedAt,
  }
}

/** Owns provider registration and the application-import workflow. */
export class ModelRegistry {
  private handle: AdapterRegistrationHandle | undefined
  private readonly adapter: FlowbaseLlmAdapter
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly store: StateStore,
    private readonly timeoutMs: number,
    transportOptions?: ResponsesTransportOptions,
  ) { this.adapter = new FlowbaseLlmAdapter(() => this.snapshot(), transportOptions, () => this.ctx.get('attachments')) }

  compact(options: GenerateOptions) { return this.adapter.compact(options) }

  /** Re-register the complete provider route set from durable state. */
  refresh(): void {
    if (this.disposed) return
    const snapshot = this.snapshot()
    const routes = [...snapshot.providers.keys()]
    if (this.handle === undefined) {
      if (routes.length === 0) return
      this.handle = this.ctx.llm.registerAdapter(routes, this.adapter)
      return
    }
    // Replacing also publishes llm/adapters-updated when only model capabilities changed.
    this.handle.replace(routes)
  }

  /** Release every route; the provider is unregistered from the model selector. */
  dispose(): void {
    this.disposed = true
    this.adapter.dispose()
    this.handle?.()
    this.handle = undefined
  }

  /**
   * List agent-flow applications. Imported applications have their catalogue
   * read back from the deployment, because the application — not this plugin —
   * decides which models it exposes.
   */
  async listApplications(instanceId: string): Promise<ApplicationView[]> {
    const instance = this.store.require(instanceId)
    const client = new FlowbaseClient({ baseUrl: instance.baseUrl, token: instance.token, timeoutMs: this.timeoutMs })
    const applications = await client.listApplications()
    const catalogues = await this.syncCatalogues(instanceId, client, instance.applications)
    return applications
      .map(application => {
        const importedApplication = catalogues.get(application.id)
        return {
          id: application.id,
          name: application.name,
          description: application.description,
          imported: importedApplication !== undefined,
          importedApplication: importedApplication === undefined ? null : applicationView(importedApplication),
        } satisfies ApplicationView
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Import one published agent-flow application as a DSH provider. */
  async importApplication(instanceId: string, applicationId: string, settings: ApplicationProtocolSettings = { protocol: 'chat-completions', remoteCompaction: true }): Promise<ImportedApplicationView> {
    const instance = this.store.require(instanceId)
    const client = new FlowbaseClient({ baseUrl: instance.baseUrl, token: instance.token, timeoutMs: this.timeoutMs })
    const applications = await client.listApplications()
    const application = applications.find(entry => entry.id === applicationId)
    if (application === undefined) {
      throw new FlowbaseError('application/not-found', `1flowbase 中没有可访问的 agent-flow 应用 ${applicationId}`)
    }
    const existing = instance.applications.find(entry => entry.applicationId === applicationId)
    let apiKey = existing?.apiKey
    let models: WireModel[] | undefined
    if (apiKey !== undefined) {
      try {
        models = wireModelsOf(await client.listApplicationModels(apiKey))
      } catch {
        apiKey = undefined
      }
    }
    if (apiKey === undefined || models === undefined) {
      apiKey = await client.createApplicationKey(applicationId, `DeepSeek Harness - ${instance.name}`)
      models = wireModelsOf(await client.listApplicationModels(apiKey))
    }
    if (models.length === 0) {
      throw new FlowbaseError(
        'application/not-published',
        `应用「${application.name}」没有可用模型。请先在 1flowbase 发布应用 API 并完成模型映射。`,
      )
    }
    const record: ImportedApplication = {
      ...settings,
      applicationId,
      name: application.name,
      description: application.description,
      apiKey,
      models,
      importedAt: new Date().toISOString(),
    }
    await this.store.update(draft => {
      const target = requireInDraft(draft.instances, instanceId)
      const index = target.applications.findIndex(entry => entry.applicationId === applicationId)
      if (index >= 0) target.applications[index] = record
      else target.applications.push(record)
      target.updatedAt = new Date().toISOString()
    })
    this.refresh()
    return applicationView(record)
  }

  /** Update only provider request settings; keep the key, model ids and import identity. */
  async updateApplication(instanceId: string, applicationId: string, settings: ApplicationProtocolSettings): Promise<ImportedApplicationView> {
    const record = await this.store.update(draft => {
      const instance = requireInDraft(draft.instances, instanceId)
      const application = instance.applications.find(entry => entry.applicationId === applicationId)
      if (application === undefined) throw new FlowbaseError('application/not-imported', 'Application is not imported')
      Object.assign(application, settings)
      instance.updatedAt = new Date().toISOString()
      return application
    })
    this.refresh()
    return applicationView(record)
  }

  /** Resolve one immutable route snapshot for compaction and request preparation. */
  resolveRoute(provider: string, model: string): AdapterModel | undefined {
    return this.snapshot().providers.get(provider)?.models.get(model)
  }

  /** Remove one imported application; its app key stays valid until revoked in 1flowbase. */
  async removeApplication(instanceId: string, applicationId: string): Promise<void> {
    await this.store.update(draft => {
      const target = requireInDraft(draft.instances, instanceId)
      target.applications = target.applications.filter(entry => entry.applicationId !== applicationId)
      target.updatedAt = new Date().toISOString()
    })
    this.refresh()
  }

  /**
   * Reconcile every imported application's catalogue once, in the background,
   * so a restart alone brings the model selector up to date — including the
   * models a migration could not know about. Failures stay per instance.
   */
  async reconcileAll(): Promise<void> {
    for (const instance of this.store.snapshot().instances) {
      if (instance.applications.length === 0) continue
      try {
        const client = new FlowbaseClient({
          baseUrl: instance.baseUrl,
          token: instance.token,
          timeoutMs: this.timeoutMs,
        })
        await this.syncCatalogues(instance.id, client, instance.applications)
      } catch (error) {
        this.ctx.logger('1flowbase').warn(
          'cannot reconcile the catalogues of instance %s: %s',
          instance.name,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  /**
   * Re-read every imported application's catalogue and persist what changed.
   * A catalogue that cannot be read keeps its stored models, so a temporarily
   * unreachable deployment does not drop working providers.
   * @returns the effective applications, keyed by application id.
   */
  private async syncCatalogues(
    instanceId: string,
    client: FlowbaseClient,
    applications: readonly ImportedApplication[],
  ): Promise<Map<string, ImportedApplication>> {
    const effective = new Map<string, ImportedApplication>()
    const changed: ImportedApplication[] = []
    for (const application of applications) {
      let models = application.models
      try {
        models = wireModelsOf(await client.listApplicationModels(application.apiKey))
      } catch {
        models = application.models
      }
      const next = { ...application, models }
      effective.set(application.applicationId, next)
      if (!sameCatalogue(application.models, models)) changed.push(next)
    }
    if (changed.length > 0) {
      await this.store.update(draft => {
        const target = requireInDraft(draft.instances, instanceId)
        for (const application of changed) {
          const index = target.applications.findIndex(entry => entry.applicationId === application.applicationId)
          if (index >= 0) target.applications[index] = { ...target.applications[index]!, models: application.models }
        }
        target.updatedAt = new Date().toISOString()
      })
      this.refresh()
    }
    // Protocol/key edits may finish while the remote catalogue is loading.
    const current = this.store.require(instanceId)
    for (const application of current.applications) {
      if (effective.has(application.applicationId)) effective.set(application.applicationId, application)
    }
    for (const id of effective.keys()) {
      if (!current.applications.some(application => application.applicationId === id)) effective.delete(id)
    }
    return effective
  }

  /** Snapshot used by the adapter on each request; no network I/O. */
  private snapshot(): AdapterSnapshot {
    const providers = new Map<string, { name: string; models: Map<string, AdapterModel> }>()
    for (const instance of this.store.snapshot().instances) {
      for (const application of instance.applications) {
        if (application.models.length === 0) continue
        const provider = providerIdFor(instance.id, application.applicationId)
        const models = new Map<string, AdapterModel>()
        for (const model of application.models) {
          models.set(model.id, {
            provider,
            applicationId: application.applicationId,
            applicationName: application.name,
            name: model.name,
            description: application.description,
            baseUrl: instance.baseUrl,
            applicationKey: application.apiKey,
            wireModel: model.id,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            protocol: application.protocol,
            remoteCompaction: application.remoteCompaction,
            ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
          })
        }
        // The application is the provider, so its own name is the group label.
        providers.set(provider, { name: application.name, models })
      }
    }
    return { providers }
  }
}

function positive(value: number | null | undefined, fallback: number): number {
  return value !== undefined && value !== null && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function requireInDraft(instances: FlowbaseInstanceRecord[], instanceId: string): FlowbaseInstanceRecord {
  const target = instances.find(entry => entry.id === instanceId)
  if (target === undefined) throw new FlowbaseError('instance/not-found', `unknown 1flowbase instance ${instanceId}`)
  return target
}

export type { FlowbaseApplication }
