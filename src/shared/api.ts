/** Shared wire types between the Host plugin and the settings page. */

export type AuthMode = 'api_key' | 'login'

export type ExpirationPolicy = '30d' | '1y' | '3y' | 'never'

export interface ImportedModel {
  applicationId: string
  name: string
  description: string
  /** Model id sent to 1flowbase; the DSH-facing model id is the application id. */
  wireModel: string
  /** Per-application API key, created by the Host and never returned to the browser. */
  apiKey: string
  contextWindow: number
  maxTokens: number
  importedAt: string
}

export interface EnabledMcp {
  mcpInstanceId: string
  name: string
  /** DSH namespace: sanitized `<name>_<instance_id>`. */
  serverName: string
  enabledAt: string
}

export interface FlowbaseInstanceRecord {
  id: string
  name: string
  baseUrl: string
  authMode: AuthMode
  /** Durable user API key used by console, app and MCP calls. */
  token: string
  workspaceId: string | null
  loginIdentifier: string | null
  models: ImportedModel[]
  mcps: EnabledMcp[]
  createdAt: string
  updatedAt: string
}

export interface PluginState {
  version: 1
  revision: number
  instances: FlowbaseInstanceRecord[]
}

export interface InstanceView {
  id: string
  name: string
  baseUrl: string
  authMode: AuthMode
  workspaceId: string | null
  loginIdentifier: string | null
  createdAt: string
  updatedAt: string
  models: ImportedModelView[]
  mcps: EnabledMcpView[]
}

export interface ImportedModelView {
  applicationId: string
  name: string
  description: string
  wireModel: string
  contextWindow: number
  maxTokens: number
  importedAt: string
}

export interface EnabledMcpView {
  mcpInstanceId: string
  name: string
  serverName: string
  enabledAt: string
}

export interface ApplicationView {
  id: string
  name: string
  description: string
  imported: boolean
  importedModel: ImportedModelView | null
}

export interface McpInstanceView {
  instanceId: string
  name: string
  description: string
  status: string
  enabled: boolean
  serverName: string
  enabledAt: string | null
}

export interface CreateInstanceInput {
  name: string
  baseUrl: string
  authMode: AuthMode
  apiKey?: string
  identifier?: string
  password?: string
  roleCode?: string
  expirationPolicy?: ExpirationPolicy
}

export interface TestResult {
  ok: boolean
  message: string
  applicationCount?: number
  mcpInstanceCount?: number
}

export interface ApiSuccess<T> {
  ok: true
  data: T
}

export interface ApiFailure {
  ok: false
  error: {
    code: string
    message: string
  }
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure
