import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FlowbaseClient, loginAndCreateToken, normalizeBaseUrl } from './flowbase.js'
import { FlowbaseError, asFlowbaseError } from './errors.js'
import type { ModelRegistry } from './models.js'
import type { McpRegistry } from './mcp.js'
import type { StateStore } from './state.js'
import type {
  ApiFailure,
  ApiSuccess,
  AuthMode,
  CreateInstanceInput,
  ExpirationPolicy,
  FlowbaseInstanceRecord,
  InstanceCredentialInput,
  InstanceView,
  TestResult,
  UpdateInstanceInput,
  UpdateInstanceResult,
} from './shared/api.js'

const MAX_BODY_BYTES = 256 * 1024
const MUTATION_HEADER = 'x-1flowbase-request'

export interface HttpDependencies {
  store: StateStore
  models: ModelRegistry
  mcps: McpRegistry
  timeoutMs: number
}

interface RouteContext {
  params: string[]
  body: unknown
  req: IncomingMessage
  url: URL
}

type RouteHandler = (context: RouteContext) => Promise<unknown>

interface Route {
  method: 'GET' | 'POST' | 'DELETE'
  pattern: RegExp
  handler: RouteHandler
}

function view(instance: FlowbaseInstanceRecord): InstanceView {
  return {
    id: instance.id,
    name: instance.name,
    baseUrl: instance.baseUrl,
    authMode: instance.authMode,
    workspaceId: instance.workspaceId,
    loginIdentifier: instance.loginIdentifier,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    applications: instance.applications.map(application => ({
      applicationId: application.applicationId,
      name: application.name,
      description: application.description,
      models: application.models.map(model => ({ ...model })),
      importedAt: application.importedAt,
    })),
    mcps: instance.mcps.map(mcp => ({
      mcpInstanceId: mcp.mcpInstanceId,
      name: mcp.name,
      serverName: mcp.serverName,
      enabledAt: mcp.enabledAt,
    })),
  }
}

function requireString(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FlowbaseError('request/invalid', `${field} 不能为空`)
  }
  const trimmed = value.trim()
  if (trimmed.length > max) throw new FlowbaseError('request/invalid', `${field} 长度不能超过 ${String(max)}`)
  return trimmed
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function parseExpirationPolicy(value: unknown): ExpirationPolicy | undefined {
  return value === '30d' || value === '1y' || value === '3y' || value === 'never'
    ? value satisfies ExpirationPolicy
    : undefined
}

function parseCreate(body: unknown): CreateInstanceInput {
  if (typeof body !== 'object' || body === null) {
    throw new FlowbaseError('request/invalid', '请求体必须是 JSON 对象')
  }
  const raw = body as Record<string, unknown>
  const authMode = raw.authMode
  if (authMode !== 'api_key' && authMode !== 'login') {
    throw new FlowbaseError('request/invalid', 'authMode 必须是 api_key 或 login')
  }
  const expirationPolicy = parseExpirationPolicy(raw.expirationPolicy)
  const apiKey = optionalString(raw.apiKey)
  const identifier = optionalString(raw.identifier)
  const password = optionalString(raw.password)
  const roleCode = optionalString(raw.roleCode)
  return {
    name: requireString(raw.name, '实例名称', 80),
    baseUrl: normalizeBaseUrl(requireString(raw.baseUrl, '1flowbase 地址', 500)),
    authMode: authMode satisfies AuthMode,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(identifier === undefined ? {} : { identifier }),
    ...(password === undefined ? {} : { password }),
    ...(roleCode === undefined ? {} : { roleCode }),
    ...(expirationPolicy === undefined ? {} : { expirationPolicy }),
  }
}

/** One credential replacement; a missing credential keeps the stored token. */
function parseCredential(value: unknown): InstanceCredentialInput {
  if (typeof value !== 'object' || value === null) {
    throw new FlowbaseError('request/invalid', 'credential 必须是 JSON 对象')
  }
  const raw = value as Record<string, unknown>
  if (raw.authMode === 'api_key') {
    return { authMode: 'api_key', apiKey: requireString(raw.apiKey, 'API Key', 500) }
  }
  if (raw.authMode === 'login') {
    const roleCode = optionalString(raw.roleCode)
    const expirationPolicy = parseExpirationPolicy(raw.expirationPolicy)
    return {
      authMode: 'login',
      identifier: requireString(raw.identifier, '登录账号', 200),
      password: requireString(raw.password, '登录密码', 500),
      ...(roleCode === undefined ? {} : { roleCode }),
      ...(expirationPolicy === undefined ? {} : { expirationPolicy }),
    }
  }
  throw new FlowbaseError('request/invalid', 'credential.authMode 必须是 api_key 或 login')
}

/** Partial instance patch; every absent field keeps its stored value. */
function parseUpdate(body: unknown): UpdateInstanceInput {
  if (typeof body !== 'object' || body === null) {
    throw new FlowbaseError('request/invalid', '请求体必须是 JSON 对象')
  }
  const raw = body as Record<string, unknown>
  const patch: UpdateInstanceInput = {}
  if (raw.name !== undefined) patch.name = requireString(raw.name, '实例名称', 80)
  if (raw.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(requireString(raw.baseUrl, '1flowbase 地址', 500))
  if (raw.credential !== undefined) patch.credential = parseCredential(raw.credential)
  if (patch.name === undefined && patch.baseUrl === undefined && patch.credential === undefined) {
    throw new FlowbaseError('request/invalid', '没有需要更新的字段')
  }
  return patch
}

function registerRoutes(deps: HttpDependencies): Route[] {
  const { store, models, mcps, timeoutMs } = deps
  return [
    {
      method: 'GET',
      pattern: /^\/mcp-references$/u,
      handler: async () => mcps.references(),
    },
    {
      method: 'GET',
      pattern: /^\/instances$/u,
      handler: async () => store.snapshot().instances.map(view),
    },
    {
      method: 'POST',
      pattern: /^\/instances$/u,
      handler: async ({ body }) => {
        const input = parseCreate(body)
        let token: string
        let workspaceId: string | null = null
        let loginIdentifier: string | null = null
        if (input.authMode === 'api_key') {
          token = requireString(input.apiKey, 'API Key', 500)
          const client = new FlowbaseClient({ baseUrl: input.baseUrl, token, timeoutMs })
          await client.test()
        } else {
          const identifier = requireString(input.identifier, '登录账号', 200)
          const password = requireString(input.password, '登录密码', 500)
          const login = await loginAndCreateToken({
            baseUrl: input.baseUrl,
            identifier,
            password,
            ...input.roleCode === undefined ? {} : { roleCode: input.roleCode },
            ...input.expirationPolicy === undefined ? {} : { expirationPolicy: input.expirationPolicy },
            timeoutMs,
          })
          token = login.token
          workspaceId = login.workspaceId
          loginIdentifier = identifier
        }
        const record = store.newInstance({
          name: input.name,
          baseUrl: input.baseUrl,
          authMode: input.authMode,
          token,
          workspaceId,
          loginIdentifier,
        })
        await store.update(draft => {
          draft.instances.push(record)
        })
        return view(record)
      },
    },
    {
      method: 'POST',
      pattern: /^\/instances\/([^/]+)\/update$/u,
      handler: async ({ params, body }): Promise<UpdateInstanceResult> => {
        const id = decodeURIComponent(params[0] ?? '')
        const current = store.require(id)
        const patch = parseUpdate(body)

        // Resolve the candidate record first, so a rejected credential or an
        // unreachable address never reaches durable state.
        const next: FlowbaseInstanceRecord = {
          ...current,
          name: patch.name ?? current.name,
          baseUrl: patch.baseUrl ?? current.baseUrl,
        }
        const credential = patch.credential
        if (credential !== undefined) {
          if (credential.authMode === 'api_key') {
            next.authMode = 'api_key'
            next.token = credential.apiKey
            next.workspaceId = null
            next.loginIdentifier = null
          } else {
            const login = await loginAndCreateToken({
              baseUrl: next.baseUrl,
              identifier: credential.identifier,
              password: credential.password,
              ...credential.roleCode === undefined ? {} : { roleCode: credential.roleCode },
              ...credential.expirationPolicy === undefined ? {} : { expirationPolicy: credential.expirationPolicy },
              timeoutMs,
            })
            next.authMode = 'login'
            next.token = login.token
            next.workspaceId = login.workspaceId
            next.loginIdentifier = credential.identifier
          }
        }

        const addressChanged = next.baseUrl !== current.baseUrl
        const credentialChanged = credential !== undefined
        if (addressChanged || credentialChanged) {
          await new FlowbaseClient({ baseUrl: next.baseUrl, token: next.token, timeoutMs }).test()
        }

        await store.update(draft => {
          const target = draft.instances.find(entry => entry.id === id)
          if (target === undefined) throw new FlowbaseError('instance/not-found', `unknown 1flowbase instance ${id}`)
          target.name = next.name
          target.baseUrl = next.baseUrl
          target.authMode = next.authMode
          target.token = next.token
          target.workspaceId = next.workspaceId
          target.loginIdentifier = next.loginIdentifier
          target.updatedAt = new Date().toISOString()
        })
        models.refresh()

        // Mounted MCP connectors captured the old address and credential, so
        // they reconnect against the new ones. A failed reconnect is reported
        // without rolling back the saved instance.
        const warnings: string[] = []
        if ((addressChanged || credentialChanged) && current.mcps.length > 0) {
          for (const mcp of current.mcps) {
            try {
              await mcps.disable(id, mcp.mcpInstanceId)
              await mcps.enable(id, mcp.mcpInstanceId)
            } catch (error) {
              warnings.push(
                `MCP「${mcp.name}」未能用新配置重新连接：${error instanceof Error ? error.message : String(error)}。请在 MCP 标签页重新启用。`,
              )
            }
          }
        }
        return { instance: view(store.require(id)), warnings }
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/instances\/([^/]+)$/u,
      handler: async ({ params }) => {
        const id = decodeURIComponent(params[0] ?? '')
        store.require(id)
        await mcps.removeInstance(id)
        await store.update(draft => {
          draft.instances = draft.instances.filter(entry => entry.id !== id)
        })
        models.refresh()
        return { id }
      },
    },
    {
      method: 'POST',
      pattern: /^\/instances\/([^/]+)\/test$/u,
      handler: async ({ params }) => {
        const instance = store.require(decodeURIComponent(params[0] ?? ''))
        const client = new FlowbaseClient({ baseUrl: instance.baseUrl, token: instance.token, timeoutMs })
        const result: TestResult = { ok: true, message: '连接成功', ...await client.test() }
        return result
      },
    },
    {
      method: 'GET',
      pattern: /^\/instances\/([^/]+)\/apps$/u,
      handler: async ({ params }) => models.listApplications(decodeURIComponent(params[0] ?? '')),
    },
    {
      method: 'POST',
      pattern: /^\/instances\/([^/]+)\/apps\/([^/]+)$/u,
      handler: async ({ params }) => models.importApplication(
        decodeURIComponent(params[0] ?? ''),
        decodeURIComponent(params[1] ?? ''),
      ),
    },
    {
      method: 'DELETE',
      pattern: /^\/instances\/([^/]+)\/apps\/([^/]+)$/u,
      handler: async ({ params }) => {
        await models.removeApplication(
          decodeURIComponent(params[0] ?? ''),
          decodeURIComponent(params[1] ?? ''),
        )
        return { removed: true }
      },
    },
    {
      method: 'GET',
      pattern: /^\/instances\/([^/]+)\/mcps$/u,
      handler: async ({ params }) => mcps.list(decodeURIComponent(params[0] ?? '')),
    },
    {
      method: 'POST',
      pattern: /^\/instances\/([^/]+)\/mcps\/([^/]+)$/u,
      handler: async ({ params }) => mcps.enable(
        decodeURIComponent(params[0] ?? ''),
        decodeURIComponent(params[1] ?? ''),
      ),
    },
    {
      method: 'DELETE',
      pattern: /^\/instances\/([^/]+)\/mcps\/([^/]+)$/u,
      handler: async ({ params }) => {
        await mcps.disable(
          decodeURIComponent(params[0] ?? ''),
          decodeURIComponent(params[1] ?? ''),
        )
        return { disabled: true }
      },
    },
  ]
}

function statusFor(error: FlowbaseError): number {
  if (error.code === 'instance/not-found' || error.code === 'application/not-found' || error.code === 'mcp/not-found' || error.code === 'model/not-found') return 404
  if (error.code.startsWith('auth/')) return 401
  if (error.code === 'mcp/connect-failed') return 502
  if (error.code === 'network') return 502
  if (error.code === 'request/invalid' || error.code === 'instance/invalid-base-url') return 400
  return 400
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new FlowbaseError('request/too-large', '请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new FlowbaseError('request/invalid', '请求体不是合法 JSON', undefined, { cause: error })
  }
}

function write(res: ServerResponse, status: number, payload: ApiSuccess<unknown> | ApiFailure): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** HTTP handler mounted at `/api/1flowbase`. */
export function createHttpHandler(deps: HttpDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = registerRoutes(deps)
  return async (req, res) => {
    try {
      if (!sameOrigin(req)) throw new FlowbaseError('request/forbidden-origin', '拒绝跨站请求')
      const url = new URL(req.url ?? '/', 'http://1flowbase.local')
      const prefix = '/api/1flowbase'
      if (!url.pathname.startsWith(prefix)) {
        write(res, 404, { ok: false, error: { code: 'request/not-found', message: 'not found' } })
        return
      }
      const path = url.pathname.slice(prefix.length) || '/'
      const method = req.method === 'POST' || req.method === 'DELETE' || req.method === 'GET' ? req.method : undefined
      if (method === undefined) throw new FlowbaseError('request/method', `unsupported method ${req.method ?? ''}`)
      if (method !== 'GET') {
        if (req.headers[MUTATION_HEADER] !== '1') {
          throw new FlowbaseError('request/forbidden', `缺少 ${MUTATION_HEADER} 请求头`)
        }
        const contentType = req.headers['content-type'] ?? ''
        if (method === 'POST' && !contentType.includes('application/json')) {
          throw new FlowbaseError('request/invalid', '请求体必须是 application/json')
        }
      }
      const route = routes.find(entry => entry.method === method && entry.pattern.test(path))
      if (route === undefined) {
        write(res, 404, { ok: false, error: { code: 'request/not-found', message: `no route for ${method} ${path}` } })
        return
      }
      const match = route.pattern.exec(path)
      const body = method === 'POST' ? await readBody(req) : undefined
      const data = await route.handler({ params: match?.slice(1) ?? [], body, req, url })
      write(res, 200, { ok: true, data })
    } catch (error) {
      const failure = asFlowbaseError(error)
      write(res, statusFor(failure), { ok: false, error: { code: failure.code, message: failure.message } })
    }
  }
}

/** Whether a request path belongs to this plugin (used before route dispatch). */
export function ownsPath(pathname: string): boolean {
  return pathname === '/api/1flowbase' || pathname.startsWith('/api/1flowbase/')
}
