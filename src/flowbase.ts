import { FlowbaseError } from './errors.js'
import type { ExpirationPolicy } from './shared/api.js'

/** One agent-flow application as the console lists it. */
export interface FlowbaseApplication {
  id: string
  application_type: string
  name: string
  description: string
  updated_at?: string
}

/** One MCP instance as the console catalog lists it. */
export interface FlowbaseMcpInstance {
  id: string
  instance_id: string
  name: string
  description_short: string | null
  status: string
}

/** One model advertised by a published application endpoint. */
export interface FlowbaseAppModel {
  id: string
  name?: string
  reasoning?: unknown
  context_window?: number
  max_output_tokens?: number
  limit?: { context?: number; output?: number }
}

interface Envelope<T> {
  data: T
}

export interface LoginResult {
  token: string
  workspaceId: string | null
  roleCode: string | null
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  token?: string
  cookie?: string
  csrf?: string
  timeoutMs?: number
}

export interface FlowbaseClientOptions {
  baseUrl: string
  token?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

/** Normalize and validate the public 1flowbase origin (path prefixes are allowed). */
export function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch (error) {
    throw new FlowbaseError('instance/invalid-base-url', `1flowbase 地址不是合法 URL: ${value}`, undefined, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FlowbaseError('instance/invalid-base-url', '1flowbase 地址必须使用 http 或 https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new FlowbaseError('instance/invalid-base-url', '1flowbase 地址不能包含用户名或密码')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new FlowbaseError('instance/invalid-base-url', '1flowbase 地址不能包含查询参数或片段')
  }
  const path = url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${path === '/' ? '' : path}`
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  const message = (body as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

function errorCode(status: number): string {
  if (status === 401) return 'auth/unauthorized'
  if (status === 403) return 'auth/forbidden'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limit'
  return 'http'
}

/** Minimal 1flowbase HTTP client for console, application and MCP endpoints. */
export class FlowbaseClient {
  readonly baseUrl: string
  readonly token: string | undefined
  readonly timeoutMs: number

  constructor(options: FlowbaseClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Fetch one console endpoint and unwrap the `{ data }` success envelope. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetch(path, options)
    const body = await readJson(response)
    if (typeof body !== 'object' || body === null || !('data' in body)) {
      throw new FlowbaseError('response/invalid', `1flowbase 响应缺少 data: ${path}`, response.status)
    }
    return (body as Envelope<T>).data
  }

  /** Fetch one public endpoint that returns a bare JSON document. */
  async requestRaw<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetch(path, options)
    return await readJson(response) as T
  }

  /** List agent-flow applications visible to the instance credential. */
  async listApplications(): Promise<FlowbaseApplication[]> {
    const applications = await this.request<FlowbaseApplication[]>('/api/console/applications')
    return applications.filter(application => application.application_type === 'agent_flow')
  }

  /** List MCP instances configured in the credential's workspace. */
  async listMcpInstances(): Promise<FlowbaseMcpInstance[]> {
    const catalog = await this.request<{ instances?: FlowbaseMcpInstance[] }>('/api/console/mcp/catalog')
    return catalog.instances ?? []
  }

  /** Create one application API key; the plaintext token is returned only here. */
  async createApplicationKey(applicationId: string, name: string): Promise<string> {
    const created = await this.request<{ token?: string }>(
      `/api/console/applications/${encodeURIComponent(applicationId)}/api-keys`,
      { method: 'POST', body: { name, expires_at: null } },
    )
    if (typeof created.token !== 'string' || created.token.length === 0) {
      throw new FlowbaseError('application/key-missing', '1flowbase 未返回应用 API Key')
    }
    return created.token
  }

  /** Read the model catalog advertised by one published application. */
  async listApplicationModels(applicationKey: string): Promise<FlowbaseAppModel[]> {
    const response = await this.requestRaw<{ data?: FlowbaseAppModel[] }>('/v1/models', {
      token: applicationKey,
    })
    return Array.isArray(response.data) ? response.data : []
  }

  /** Verify the credential against the console and report visible resources. */
  async test(): Promise<{ applicationCount: number; mcpInstanceCount: number }> {
    const [applications, mcps] = await Promise.all([this.listApplications(), this.listMcpInstances()])
    return { applicationCount: applications.length, mcpInstanceCount: mcps.length }
  }

  private async fetch(path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const token = options.token ?? this.token
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    if (options.cookie !== undefined) headers.cookie = options.cookie
    if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf
    let response: Response
    try {
      const init: RequestInit = {
        method: options.method ?? 'GET',
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      }
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
      response = await fetch(joinUrl(this.baseUrl, path), init)
    } catch (error) {
      throw new FlowbaseError('network', `无法连接 1flowbase: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error })
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined)
      throw new FlowbaseError(
        errorCode(response.status),
        `${errorMessage(body, `1flowbase 返回 HTTP ${String(response.status)}`)}`,
        response.status,
      )
    }
    return response
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new FlowbaseError('response/invalid', '1flowbase 返回了非 JSON 响应', response.status, { cause: error })
  }
}

function cookiesFrom(response: Response): string {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = typeof getSetCookie === 'function' ? getSetCookie.call(response.headers) : []
  return values.map(value => value.split(';', 1)[0] ?? '').filter(Boolean).join('; ')
}

interface RoleOption {
  code: string
  name: string
  scope_kind: string
}

interface SignInPayload {
  csrf_token: string
  effective_display_role: string
  current_workspace_id: string
}

interface PersonalAccessToken {
  token?: string
  role_code?: string | null
}

/**
 * Sign in with a local account and exchange the one-time console session for a
 * durable user API key. The password is used for this call only.
 */
export async function loginAndCreateToken(options: {
  baseUrl: string
  identifier: string
  password: string
  roleCode?: string
  expirationPolicy?: ExpirationPolicy
  timeoutMs?: number
}): Promise<LoginResult> {
  const client = new FlowbaseClient({ baseUrl: options.baseUrl, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
  const response = await fetch(joinUrl(client.baseUrl, '/api/public/auth/sign-in'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identifier: options.identifier, password: options.password }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  const cookie = cookiesFrom(response)
  const body = await readJson(response)
  if (!response.ok) {
    throw new FlowbaseError(
      errorCode(response.status),
      `1flowbase 登录失败: ${errorMessage(body, `HTTP ${String(response.status)}`)}`,
      response.status,
    )
  }
  if (cookie.length === 0) {
    throw new FlowbaseError('auth/login-no-session', '1flowbase 登录成功但未返回会话 Cookie')
  }
  const signIn = (body as Envelope<SignInPayload> | undefined)?.data
  if (signIn === undefined || typeof signIn.csrf_token !== 'string' || signIn.csrf_token.length === 0) {
    throw new FlowbaseError('auth/login-invalid', '1flowbase 登录响应缺少 csrf_token')
  }

  const roleOptions = await client.request<{ items?: RoleOption[] }>('/api/console/user-api-keys/role-options', {
    cookie,
  })
  const items = roleOptions.items ?? []
  if (items.length === 0) {
    throw new FlowbaseError('auth/no-role', '当前账号没有可创建 API Key 的角色')
  }
  const selected = options.roleCode === undefined
    ? items.find(item => item.code === signIn.effective_display_role) ?? items[0]
    : items.find(item => item.code === options.roleCode)
  if (selected === undefined) {
    throw new FlowbaseError('auth/unknown-role', `账号没有角色 ${options.roleCode ?? ''}`)
  }

  const created = await client.request<PersonalAccessToken>('/api/console/user-api-keys', {
    method: 'POST',
    cookie,
    csrf: signIn.csrf_token,
    body: {
      name: `DeepSeek Harness (${new Date().toISOString().slice(0, 10)})`,
      role_code: selected.code,
      expiration_policy: options.expirationPolicy ?? '1y',
    },
  })
  if (typeof created.token !== 'string' || created.token.length === 0) {
    throw new FlowbaseError('auth/token-missing', '1flowbase 未返回用户 API Key')
  }
  return {
    token: created.token,
    workspaceId: signIn.current_workspace_id ?? null,
    roleCode: created.role_code ?? selected.code,
  }
}

/** Fetch the role choices a signed-in account can mint tokens for. */
export async function listLoginRoles(baseUrl: string, cookie: string): Promise<RoleOption[]> {
  const client = new FlowbaseClient({ baseUrl })
  const response = await client.request<{ items?: RoleOption[] }>('/api/console/user-api-keys/role-options', { cookie })
  return response.items ?? []
}
