import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { FlowbaseClient } from './flowbase.js'
import type { FlowbaseApplication } from './flowbase.js'
import { FlowbaseError } from './errors.js'
import type { AdapterModel, AdapterSnapshot } from './adapter.js'
import { FlowbaseLlmAdapter } from './adapter.js'
import type { StateStore } from './state.js'
import type {
  ApplicationView,
  FlowbaseInstanceRecord,
  ImportedModel,
  ImportedModelView,
} from './shared/api.js'

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 32_768

/** Route id for one instance; stable across restarts and model changes. */
export function providerIdFor(instanceId: string): string {
  return `fb_${instanceId.replace(/-/gu, '')}`
}

function modelView(model: ImportedModel): ImportedModelView {
  return {
    applicationId: model.applicationId,
    name: model.name,
    description: model.description,
    wireModel: model.wireModel,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    importedAt: model.importedAt,
  }
}

/** Owns provider registration and the application-import workflow. */
export class ModelRegistry {
  private handle: AdapterRegistrationHandle | undefined
  private routes: string[] = []
  private readonly adapter = new FlowbaseLlmAdapter(() => this.snapshot())
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly store: StateStore,
    private readonly timeoutMs: number,
  ) {}

  /** Re-register the complete provider route set from durable state. */
  refresh(): void {
    if (this.disposed) return
    const snapshot = this.snapshot()
    const routes = [...snapshot.providers.keys()]
    if (this.handle === undefined) {
      if (routes.length === 0) return
      this.handle = this.ctx.llm.registerAdapter(routes, this.adapter)
      this.routes = [...routes]
      return
    }
    if (routes.length === this.routes.length && routes.every((route, index) => route === this.routes[index])) return
    this.handle.replace(routes)
    this.routes = [...routes]
  }

  /** Release every route; the provider is unregistered from the model selector. */
  dispose(): void {
    this.disposed = true
    this.handle?.()
    this.handle = undefined
    this.routes = []
  }

  /** List agent-flow applications with their local import state. */
  async listApplications(instanceId: string): Promise<ApplicationView[]> {
    const instance = this.store.require(instanceId)
    const client = new FlowbaseClient({ baseUrl: instance.baseUrl, token: instance.token, timeoutMs: this.timeoutMs })
    const applications = await client.listApplications()
    const imported = new Map(instance.models.map(model => [model.applicationId, model]))
    return applications
      .map(application => {
        const model = imported.get(application.id)
        return {
          id: application.id,
          name: application.name,
          description: application.description,
          imported: model !== undefined,
          importedModel: model === undefined ? null : modelView(model),
        } satisfies ApplicationView
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Import one published agent-flow application as a DSH model. */
  async importApplication(instanceId: string, applicationId: string): Promise<ImportedModelView> {
    const instance = this.store.require(instanceId)
    const client = new FlowbaseClient({ baseUrl: instance.baseUrl, token: instance.token, timeoutMs: this.timeoutMs })
    const applications = await client.listApplications()
    const application = applications.find(entry => entry.id === applicationId)
    if (application === undefined) {
      throw new FlowbaseError('application/not-found', `1flowbase 中没有可访问的 agent-flow 应用 ${applicationId}`)
    }
    const existingModel = instance.models.find(model => model.applicationId === applicationId)
    let applicationKey = existingModel?.apiKey
    let models: Awaited<ReturnType<typeof client.listApplicationModels>> | undefined
    if (applicationKey !== undefined) {
      try {
        models = await client.listApplicationModels(applicationKey)
      } catch {
        applicationKey = undefined
      }
    }
    if (applicationKey === undefined || models === undefined) {
      applicationKey = await client.createApplicationKey(applicationId, `DeepSeek Harness - ${instance.name}`)
      models = await client.listApplicationModels(applicationKey)
    }
    const wire = models[0]
    if (wire === undefined) {
      throw new FlowbaseError(
        'application/not-published',
        `应用「${application.name}」没有可用模型。请先在 1flowbase 发布应用 API 并完成模型映射。`,
      )
    }
    const contextWindow = positive(wire.context_window ?? wire.limit?.context, DEFAULT_CONTEXT_WINDOW)
    const maxTokens = positive(wire.max_output_tokens ?? wire.limit?.output, DEFAULT_MAX_TOKENS)
    const record: ImportedModel = {
      applicationId,
      name: application.name,
      description: application.description,
      wireModel: wire.id,
      apiKey: applicationKey,
      contextWindow,
      maxTokens,
      importedAt: new Date().toISOString(),
    }
    await this.store.update(draft => {
      const target = requireInDraft(draft.instances, instanceId)
      const existing = target.models.findIndex(model => model.applicationId === applicationId)
      if (existing >= 0) target.models[existing] = record
      else target.models.push(record)
      target.updatedAt = new Date().toISOString()
    })
    this.refresh()
    return modelView(record)
  }

  /** Remove one imported application; its app key stays valid until revoked in 1flowbase. */
  async removeApplication(instanceId: string, applicationId: string): Promise<void> {
    await this.store.update(draft => {
      const target = requireInDraft(draft.instances, instanceId)
      target.models = target.models.filter(model => model.applicationId !== applicationId)
      target.updatedAt = new Date().toISOString()
    })
    this.refresh()
  }

  /** Snapshot used by the adapter on each request; no network I/O. */
  private snapshot(): AdapterSnapshot {
    const providers = new Map<string, { name: string; models: Map<string, AdapterModel> }>()
    for (const instance of this.store.snapshot().instances) {
      const models = new Map<string, AdapterModel>()
      for (const model of instance.models) {
        models.set(model.applicationId, {
          provider: providerIdFor(instance.id),
          applicationId: model.applicationId,
          name: model.name,
          description: model.description,
          baseUrl: instance.baseUrl,
          applicationKey: model.apiKey,
          wireModel: model.wireModel,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })
      }
      if (models.size > 0) providers.set(providerIdFor(instance.id), { name: instance.name, models })
    }
    return { providers }
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function requireInDraft(instances: FlowbaseInstanceRecord[], instanceId: string): FlowbaseInstanceRecord {
  const target = instances.find(entry => entry.id === instanceId)
  if (target === undefined) throw new FlowbaseError('instance/not-found', `unknown 1flowbase instance ${instanceId}`)
  return target
}

export type { FlowbaseApplication }
