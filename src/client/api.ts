import type {
  ApiResponse,
  ApplicationView,
  CreateInstanceInput,
  ImportedApplicationView,
  InstanceView,
  McpInstanceView,
  McpReference,
  TestResult,
  UpdateInstanceInput,
  UpdateInstanceResult,
} from '../shared/api.js'

const PREFIX = '/api/1flowbase'

async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.method !== undefined && init.method !== 'GET') headers['x-1flowbase-request'] = '1'
  const response = await fetch(`${PREFIX}${path}`, {
    method: init.method ?? 'GET',
    ...(init.signal === undefined ? {} : { signal: init.signal }),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  let payload: ApiResponse<T>
  try {
    payload = await response.json() as ApiResponse<T>
  } catch {
    throw new Error(`1flowbase 插件返回了非 JSON 响应 (HTTP ${String(response.status)})`)
  }
  if (payload.ok !== true) throw new Error(payload.error.message)
  return payload.data
}

export const flowbaseApi = {
  mcpReferences: (signal: AbortSignal) => request<McpReference[]>('/mcp-references', { signal }),
  listInstances: () => request<InstanceView[]>('/instances'),
  createInstance: (input: CreateInstanceInput) => request<InstanceView>('/instances', { method: 'POST', body: input }),
  updateInstance: (id: string, input: UpdateInstanceInput) =>
    request<UpdateInstanceResult>(`/instances/${encodeURIComponent(id)}/update`, { method: 'POST', body: input }),
  deleteInstance: (id: string) => request<{ id: string }>(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testInstance: (id: string) => request<TestResult>(`/instances/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} }),
  listApplications: (id: string) => request<ApplicationView[]>(`/instances/${encodeURIComponent(id)}/apps`),
  importApplication: (id: string, applicationId: string) =>
    request<ImportedApplicationView>(`/instances/${encodeURIComponent(id)}/apps/${encodeURIComponent(applicationId)}`, { method: 'POST', body: {} }),
  removeApplication: (id: string, applicationId: string) =>
    request<{ removed: true }>(`/instances/${encodeURIComponent(id)}/apps/${encodeURIComponent(applicationId)}`, { method: 'DELETE' }),
  listMcps: (id: string) => request<McpInstanceView[]>(`/instances/${encodeURIComponent(id)}/mcps`),
  enableMcp: (id: string, mcpId: string) =>
    request<McpInstanceView>(`/instances/${encodeURIComponent(id)}/mcps/${encodeURIComponent(mcpId)}`, { method: 'POST', body: {} }),
  disableMcp: (id: string, mcpId: string) =>
    request<{ disabled: true }>(`/instances/${encodeURIComponent(id)}/mcps/${encodeURIComponent(mcpId)}`, { method: 'DELETE' }),
}
