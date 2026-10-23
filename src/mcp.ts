import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { FlowbaseClient } from './flowbase.js'
import type { FlowbaseMcpInstance } from './flowbase.js'
import { FlowbaseError } from './errors.js'
import type { StateStore } from './state.js'
import type { EnabledMcp, FlowbaseInstanceRecord, McpInstanceView, McpReference } from './shared/api.js'

const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

interface McpClientModule {
  apply: (ctx: Context, config: unknown) => Promise<void>
  Config?: (input: unknown) => unknown
}

/** Resolve the exact MCP client copy that the running DSH installation owns. */
async function loadMcpClient(): Promise<McpClientModule> {
  const entry = process.argv[1]
  if (entry !== undefined) {
    try {
      const require = createRequire(realpathSync(entry))
      const resolved = require.resolve(MCP_CLIENT_PACKAGE)
      return await import(pathToFileURL(resolved).href) as McpClientModule
    } catch {
      // Fall through to ordinary package resolution (tests and development).
    }
  }
  return await import(MCP_CLIENT_PACKAGE) as McpClientModule
}

/** Sanitize a display name plus instance id into the MCP server namespace grammar. */
export function mcpServerName(name: string, instanceId: string): string {
  const sanitize = (value: string): string => value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 6)
  const nameToken = sanitize(name) || `mcp_${hash}`
  const idToken = sanitize(instanceId) || hash
  return `${nameToken}_${idToken}`.slice(0, 32)
}

function keyOf(instanceId: string, mcpInstanceId: string): string {
  return `${instanceId}:${mcpInstanceId}`
}

/** Owns dynamic mcp-client children so enabling/switching is instant and reversible. */
export class McpRegistry {
  private readonly children = new Map<string, Fiber>()
  private readonly names = new Map<string, string>()
  private readonly enabled = new Map<string, EnabledMcp>()
  private module: McpClientModule | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly store: StateStore,
    private readonly timeoutMs: number,
  ) {}

  /** Restore every enabled instance after a Host restart; failures stay per-instance. */
  async restore(): Promise<void> {
    for (const instance of this.store.snapshot().instances) {
      for (const mcp of instance.mcps) {
        try {
          await this.mount(instance, mcp)
        } catch (error) {
          this.ctx.logger('1flowbase').warn('cannot restore MCP %s: %s', mcp.serverName, error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  /** Project committed, mounted connectors for input references without contacting upstream. */
  references(): McpReference[] {
    return this.store.snapshot().instances.flatMap(instance => instance.mcps
      .filter(mcp => this.children.has(keyOf(instance.id, mcp.mcpInstanceId)))
      .map(mcp => ({
        instanceId: instance.id,
        instanceName: instance.name,
        mcpInstanceId: mcp.mcpInstanceId,
        name: mcp.name,
        serverName: mcp.serverName,
      })))
  }

  /** List the workspace MCP instances and their local enabled state. */
  async list(instanceId: string): Promise<McpInstanceView[]> {
    const instance = this.store.require(instanceId)
    const client = new FlowbaseClient({ baseUrl: instance.baseUrl, token: instance.token, timeoutMs: this.timeoutMs })
    const mcps = await client.listMcpInstances()
    const local = new Map(instance.mcps.map(entry => [entry.mcpInstanceId, entry]))
    return mcps
      .map(mcp => {
        const enabled = local.get(mcp.instance_id)
        return {
          instanceId: mcp.instance_id,
          name: mcp.name,
          description: mcp.description_short ?? '',
          status: mcp.status,
          enabled: enabled !== undefined,
          serverName: enabled?.serverName ?? mcpServerName(mcp.name, mcp.instance_id),
          enabledAt: enabled?.enabledAt ?? null,
        } satisfies McpInstanceView
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Mount one MCP instance as a DSH connector and persist the choice. */
  async enable(instanceId: string, mcpInstanceId: string): Promise<McpInstanceView> {
    const instance = this.store.require(instanceId)
    if (instance.mcps.some(entry => entry.mcpInstanceId === mcpInstanceId)) {
      const existing = instance.mcps.find(entry => entry.mcpInstanceId === mcpInstanceId)
      if (existing !== undefined) {
        return {
          instanceId: existing.mcpInstanceId,
          name: existing.name,
          description: '',
          status: 'enabled',
          enabled: true,
          serverName: existing.serverName,
          enabledAt: existing.enabledAt,
        }
      }
    }
    const client = new FlowbaseClient({ baseUrl: instance.baseUrl, token: instance.token, timeoutMs: this.timeoutMs })
    const mcps = await client.listMcpInstances()
    const mcp = mcps.find(entry => entry.instance_id === mcpInstanceId)
    if (mcp === undefined) {
      throw new FlowbaseError('mcp/not-found', `1flowbase 中没有 MCP 实例 ${mcpInstanceId}`)
    }
    const enabled: EnabledMcp = {
      mcpInstanceId,
      name: mcp.name,
      serverName: this.uniqueName(mcpServerName(mcp.name, mcpInstanceId), keyOf(instanceId, mcpInstanceId)),
      enabledAt: new Date().toISOString(),
    }
    await this.mount(instance, enabled)
    try {
      await this.store.update(draft => {
        const target = draft.instances.find(entry => entry.id === instanceId)
        if (target === undefined) throw new FlowbaseError('instance/not-found', `unknown 1flowbase instance ${instanceId}`)
        if (!target.mcps.some(entry => entry.mcpInstanceId === mcpInstanceId)) target.mcps.push(enabled)
        target.updatedAt = new Date().toISOString()
      })
    } catch (error) {
      await this.unmount(instanceId, mcpInstanceId)
      throw error
    }
    return {
      instanceId,
      name: mcp.name,
      description: mcp.description_short ?? '',
      status: mcp.status,
      enabled: true,
      serverName: enabled.serverName,
      enabledAt: enabled.enabledAt,
    }
  }

  /** Unmount one connector and forget the choice. */
  async disable(instanceId: string, mcpInstanceId: string): Promise<void> {
    await this.unmount(instanceId, mcpInstanceId)
    await this.store.update(draft => {
      const target = draft.instances.find(entry => entry.id === instanceId)
      if (target === undefined) return
      target.mcps = target.mcps.filter(entry => entry.mcpInstanceId !== mcpInstanceId)
      target.updatedAt = new Date().toISOString()
    })
  }

  /** Unmount every connector owned by a deleted instance. */
  async removeInstance(instanceId: string): Promise<void> {
    const instance = this.store.snapshot().instances.find(entry => entry.id === instanceId)
    for (const mcp of instance?.mcps ?? []) await this.disable(instanceId, mcp.mcpInstanceId)
  }

  /** Dispose every dynamically mounted connector. */
  async dispose(): Promise<void> {
    this.disposed = true
    const children = [...this.children.values()]
    this.children.clear()
    this.names.clear()
    await Promise.all(children.map(async child => await Promise.resolve(child.dispose())))
  }

  private async unmount(instanceId: string, mcpInstanceId: string): Promise<void> {
    const key = keyOf(instanceId, mcpInstanceId)
    const child = this.children.get(key)
    if (child === undefined) return
    this.children.delete(key)
    this.names.delete(key)
    await Promise.resolve(child.dispose())
  }

  private async mount(instance: FlowbaseInstanceRecord, mcp: EnabledMcp): Promise<void> {
    if (this.disposed) throw new FlowbaseError('plugin/disposed', 'plugin is shutting down')
    const key = keyOf(instance.id, mcp.mcpInstanceId)
    if (this.children.has(key)) return
    this.module ??= await loadMcpClient()
    const config = {
      transport: 'streamable-http' as const,
      serverName: mcp.serverName,
      url: `${instance.baseUrl}/api/mcp/${encodeURIComponent(mcp.mcpInstanceId)}`,
      headers: { authorization: `Bearer ${instance.token}` },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    }
    const validated = this.module.Config === undefined ? config : this.module.Config(config)
    let child: Fiber | undefined
    try {
      child = this.ctx.plugin(this.module as never, validated as never) as unknown as Fiber
      await (child as unknown as PromiseLike<unknown>)
      this.children.set(key, child)
      this.names.set(key, mcp.serverName)
    } catch (error) {
      if (child !== undefined) await Promise.resolve(child.dispose()).catch(() => undefined)
      throw new FlowbaseError(
        'mcp/connect-failed',
        `无法连接 MCP 实例「${mcp.name}」: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      )
    }
  }

  private uniqueName(base: string, key: string): string {
    const busy = new Set([...this.names.entries()].filter(([other]) => other !== key).map(([, name]) => name))
    if (!busy.has(base)) return base
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const tail = `_${String(suffix)}`
      const candidate = `${base.slice(0, 32 - tail.length)}${tail}`
      if (!busy.has(candidate)) return candidate
    }
    throw new FlowbaseError('mcp/name-conflict', `MCP server 名称冲突: ${base}`)
  }
}
