/** Shared wire types between the Host plugin and the settings page. */

export type AuthMode = 'api_key' | 'login'

export type ExpirationPolicy = '30d' | '1y' | '3y' | 'never'

/**
 * One model an application advertises through its own `/v1/models`. An imported
 * application is a provider, and these entries are the models under it.
 */
export interface WireModel {
  id: string
  /** Display name reported by the catalogue; falls back to the model id. */
  name: string
  contextWindow: number
  maxTokens: number
}

/**
 * One imported Agent Flow application. It owns its application API key and the
 * model catalogue it publishes, so the application maps to exactly one DSH
 * provider and its catalogue entries map to that provider's models.
 */
export interface ImportedApplication {
  applicationId: string
  name: string
  description: string
  /** Application API key; the credential every model below is called with. */
  apiKey: string
  models: WireModel[]
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
  /** Imported applications; each one is a provider in the model selector. */
  applications: ImportedApplication[]
  mcps: EnabledMcp[]
  createdAt: string
  updatedAt: string
}

export interface PluginState {
  /** 1 stored one wire model per import; 2 stores the application's catalogue. */
  version: 2
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
  applications: ImportedApplicationView[]
  mcps: EnabledMcpView[]
}

export interface WireModelView {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export interface ImportedApplicationView {
  applicationId: string
  name: string
  description: string
  models: WireModelView[]
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
  importedApplication: ImportedApplicationView | null
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

/** Credential replacement carried by an instance update; omitting it keeps the stored token. */
export type InstanceCredentialInput =
  | { authMode: 'api_key'; apiKey: string }
  | {
    authMode: 'login'
    identifier: string
    password: string
    roleCode?: string
    expirationPolicy?: ExpirationPolicy
  }

/** Every field is optional: an absent field keeps its stored value. */
export interface UpdateInstanceInput {
  name?: string
  baseUrl?: string
  credential?: InstanceCredentialInput
}

export interface UpdateInstanceResult {
  instance: InstanceView
  /**
   * Non-fatal follow-up failures, such as an MCP connector that could not be
   * remounted onto the new address or credential. The instance is saved.
   */
  warnings: string[]
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
