import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { flowbaseApi } from './api.js'
import { STYLES } from './styles.js'
import type {
  ApplicationView,
  AuthMode,
  CreateInstanceInput,
  ExpirationPolicy,
  InstanceView,
  McpInstanceView,
} from '../shared/api.js'

function isChinese(): boolean {
  return navigator.language.toLowerCase().startsWith('zh')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8)
}

function CreateInstanceDialog({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (instance: InstanceView) => void
}) {
  const zh = isChinese()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:7800')
  const [authMode, setAuthMode] = useState<AuthMode>('api_key')
  const [apiKey, setApiKey] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [roleCode, setRoleCode] = useState('')
  const [expirationPolicy, setExpirationPolicy] = useState<ExpirationPolicy>('1y')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      if (name.trim().length === 0) throw new Error(zh ? '请填写实例名称' : 'Instance name is required')
      if (baseUrl.trim().length === 0) throw new Error(zh ? '请填写 1flowbase 地址' : '1flowbase URL is required')
      const input: CreateInstanceInput = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authMode,
        ...(authMode === 'api_key' ? { apiKey: apiKey.trim() } : {
          identifier: identifier.trim(),
          password,
          ...(roleCode.trim().length > 0 ? { roleCode: roleCode.trim() } : {}),
          expirationPolicy,
        }),
      }
      const created = await flowbaseApi.createInstance(input)
      onCreated(created)
    } catch (failure) {
      setError(errorText(failure))
      setBusy(false)
    }
  }

  return <div className="fb-modal-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose()
  }}>
    <div className="fb-modal" role="dialog" aria-modal="true" aria-labelledby="fb-create-title">
      <h3 id="fb-create-title">{zh ? '新建 1flowbase 实例' : 'New 1flowbase instance'}</h3>
      <p className="fb-hint">
        {zh
          ? '一个实例对应一个 1flowbase 部署和一份凭据。实例创建后会立即验证连接。'
          : 'One instance maps to one 1flowbase deployment and credential. The connection is verified on save.'}
      </p>
      <form className="fb-form" onSubmit={event => { void submit(event) }}>
        <label className="fb-field"><span>{zh ? '实例名称' : 'Instance name'}</span>
          <input value={name} onChange={event => setName(event.target.value)} placeholder={zh ? '例如：本地开发' : 'e.g. Local dev'} autoFocus />
        </label>
        <label className="fb-field"><span>{zh ? '1flowbase 地址' : '1flowbase URL'}</span>
          <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://1flowbase.example.com" spellCheck={false} />
        </label>
        <div className="fb-field"><span>{zh ? '登录方式' : 'Authentication'}</span>
          <div className="fb-radio">
            <label><input type="radio" name="fb-auth" checked={authMode === 'api_key'} onChange={() => setAuthMode('api_key')} />API Key</label>
            <label><input type="radio" name="fb-auth" checked={authMode === 'login'} onChange={() => setAuthMode('login')} />{zh ? '登录授权' : 'Sign in'}</label>
          </div>
        </div>
        {authMode === 'api_key' ? <label className="fb-field"><span>{zh ? '用户 API Key' : 'User API key'}</span>
          <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="1flowbase 用户 API Key" autoComplete="off" spellCheck={false} />
        </label> : <>
          <label className="fb-field"><span>{zh ? '账号（邮箱 / 用户名）' : 'Identifier (email / username)'}</span>
            <input value={identifier} onChange={event => setIdentifier(event.target.value)} autoComplete="username" spellCheck={false} />
          </label>
          <label className="fb-field"><span>{zh ? '密码' : 'Password'}</span>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" />
          </label>
          <label className="fb-field"><span>{zh ? '角色代码（可选）' : 'Role code (optional)'}</span>
            <input value={roleCode} onChange={event => setRoleCode(event.target.value)} placeholder={zh ? '留空则自动选择当前角色' : 'Auto-selects the current role'} spellCheck={false} />
          </label>
          <label className="fb-field"><span>{zh ? '自动创建的 API Key 有效期' : 'Generated API key lifetime'}</span>
            <select value={expirationPolicy} onChange={event => setExpirationPolicy(event.target.value as ExpirationPolicy)}>
              <option value="30d">30 {zh ? '天' : 'days'}</option>
              <option value="1y">1 {zh ? '年' : 'year'}</option>
              <option value="3y">3 {zh ? '年' : 'years'}</option>
              <option value="never">{zh ? '永久' : 'Never expires'}</option>
            </select>
          </label>
          <p className="fb-hint" style={{ margin: 0 }}>
            {zh
              ? '登录只用于换取一枚长期的用户 API Key。密码不会写入插件状态；API Key 保存在 $DSH_HOME/1flowbase-dsh-plugin/state.json（权限 0600）。'
              : 'Sign-in only exchanges a durable user API key. The password is never persisted; the API key is stored in $DSH_HOME/1flowbase-dsh-plugin/state.json (0600).'}
          </p>
        </>}
        {error === undefined ? null : <p className="fb-error" style={{ margin: 0 }}>{error}</p>}
        <div className="fb-form-actions">
          <button className="fb-btn" type="button" onClick={onClose} disabled={busy}>{zh ? '取消' : 'Cancel'}</button>
          <button className="fb-btn" data-primary="true" type="submit" disabled={busy}>{busy ? (zh ? '正在验证…' : 'Verifying…') : (zh ? '创建实例' : 'Create instance')}</button>
        </div>
      </form>
    </div>
  </div>
}

export function FlowbasePanel() {
  const zh = isChinese()
  const [instances, setInstances] = useState<InstanceView[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [createOpen, setCreateOpen] = useState(false)
  const [applications, setApplications] = useState<ApplicationView[]>([])
  const [mcps, setMcps] = useState<McpInstanceView[]>([])
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()

  const selected = useMemo(() => instances.find(instance => instance.id === selectedId), [instances, selectedId])

  const loadInstances = useCallback(async (): Promise<InstanceView[]> => {
    const list = await flowbaseApi.listInstances()
    setInstances(list)
    setSelectedId(current => current !== undefined && list.some(instance => instance.id === current)
      ? current
      : list[0]?.id)
    return list
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await flowbaseApi.listInstances()
        if (cancelled) return
        setInstances(list)
        setSelectedId(list[0]?.id)
      } catch (failure) {
        if (!cancelled) setError(errorText(failure))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (selectedId === undefined) {
      setApplications([])
      setMcps([])
      return
    }
    let cancelled = false
    setDetailLoading(true)
    void (async () => {
      try {
        const [appList, mcpList] = await Promise.all([
          flowbaseApi.listApplications(selectedId),
          flowbaseApi.listMcps(selectedId),
        ])
        if (cancelled) return
        setApplications(appList)
        setMcps(mcpList)
      } catch (failure) {
        if (!cancelled) setError(errorText(failure))
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedId])

  const refreshAll = async (): Promise<void> => {
    setBusy('refresh')
    setError(undefined)
    try {
      const list = await loadInstances()
      const id = selectedId !== undefined && list.some(instance => instance.id === selectedId)
        ? selectedId
        : list[0]?.id
      if (id !== undefined) {
        const [appList, mcpList] = await Promise.all([flowbaseApi.listApplications(id), flowbaseApi.listMcps(id)])
        setApplications(appList)
        setMcps(mcpList)
      }
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const test = async (instance: InstanceView): Promise<void> => {
    setBusy(`test:${instance.id}`)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await flowbaseApi.testInstance(instance.id)
      setNotice(zh
        ? `「${instance.name}」连接成功：${String(result.applicationCount ?? 0)} 个 Agent Flow 应用，${String(result.mcpInstanceCount ?? 0)} 个 MCP 实例。`
        : `"${instance.name}" connected: ${String(result.applicationCount ?? 0)} agent-flow apps, ${String(result.mcpInstanceCount ?? 0)} MCP instances.`)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (instance: InstanceView): Promise<void> => {
    const confirmed = window.confirm(zh
      ? `删除实例「${instance.name}」？已导入模型和已启用的 MCP 连接会一起移除，但不会删除 1flowbase 中的 API Key。`
      : `Delete instance "${instance.name}"? Imported models and enabled MCP connectors are removed; API keys in 1flowbase are not revoked.`)
    if (!confirmed) return
    setBusy(`delete:${instance.id}`)
    setError(undefined)
    setNotice(undefined)
    try {
      await flowbaseApi.deleteInstance(instance.id)
      const list = await loadInstances()
      if (list.length === 0) {
        setApplications([])
        setMcps([])
      }
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const importApplication = async (application: ApplicationView): Promise<void> => {
    if (selectedId === undefined) return
    setBusy(`app:${application.id}`)
    setError(undefined)
    setNotice(undefined)
    try {
      await flowbaseApi.importApplication(selectedId, application.id)
      const [appList, mcpList] = await Promise.all([
        flowbaseApi.listApplications(selectedId),
        flowbaseApi.listMcps(selectedId),
      ])
      setApplications(appList)
      setMcps(mcpList)
      await loadInstances()
      setNotice(zh ? `已导入模型「${application.name}」。` : `Imported model "${application.name}".`)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const removeApplication = async (application: ApplicationView): Promise<void> => {
    if (selectedId === undefined) return
    setBusy(`app:${application.id}`)
    setError(undefined)
    setNotice(undefined)
    try {
      await flowbaseApi.removeApplication(selectedId, application.id)
      setApplications(await flowbaseApi.listApplications(selectedId))
      await loadInstances()
      setNotice(zh ? `已移除模型「${application.name}」。` : `Removed model "${application.name}".`)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const toggleMcp = async (mcp: McpInstanceView): Promise<void> => {
    if (selectedId === undefined) return
    setBusy(`mcp:${mcp.instanceId}`)
    setError(undefined)
    setNotice(undefined)
    try {
      if (mcp.enabled) {
        await flowbaseApi.disableMcp(selectedId, mcp.instanceId)
        setNotice(zh ? `已停用 MCP「${mcp.name}」。` : `Disabled MCP "${mcp.name}".`)
      } else {
        await flowbaseApi.enableMcp(selectedId, mcp.instanceId)
        setNotice(zh
          ? `已启用 MCP「${mcp.name}」，工具命名空间为 mcp__${mcp.serverName}__*。`
          : `Enabled MCP "${mcp.name}" as mcp__${mcp.serverName}__*.`)
      }
      setMcps(await flowbaseApi.listMcps(selectedId))
      await loadInstances()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }

  return <section className="fb-section">
    <h2>{zh ? '1flowbase' : '1flowbase'}</h2>
    <p className="fb-hint">
      {zh
        ? '管理 1flowbase 实例，把 Agent Flow 应用导入为模型，并把 MCP 实例挂载为连接器工具。MCP 工具按 mcp__<实例名>_<instance_id>__<工具名> 区分。'
        : 'Manage 1flowbase instances, import agent-flow applications as models, and mount MCP instances as connector tools. MCP tools are namespaced mcp__<name>_<instance_id>__<tool>.'}
    </p>

    {error === undefined ? null : <p className="fb-error">{error}</p>}
    {notice === undefined ? null : <p className="fb-ok">{notice}</p>}

    <div className="fb-toolbar">
      <button className="fb-btn" data-primary="true" onClick={() => setCreateOpen(true)} disabled={busy !== undefined}>
        {zh ? '新建实例' : 'New instance'}
      </button>
      <button className="fb-btn" onClick={() => { void refreshAll() }} disabled={busy !== undefined}>
        {busy === 'refresh' ? (zh ? '正在刷新…' : 'Refreshing…') : (zh ? '刷新' : 'Refresh')}
      </button>
      <span className="fb-spacer" />
      <span className="fb-item-meta">{instances.length} {zh ? '个实例' : 'instance(s)'}</span>
    </div>

    <div className="fb-table-wrap">
      <table className="fb-table">
        <thead>
          <tr>
            <th>{zh ? '名称 / 地址' : 'Name / URL'}</th>
            <th>{zh ? '登录方式' : 'Authentication'}</th>
            <th>{zh ? '模型' : 'Models'}</th>
            <th>{zh ? 'MCP' : 'MCP'}</th>
            <th>{zh ? '操作' : 'Actions'}</th>
          </tr>
        </thead>
        <tbody>
          {instances.map(instance => <tr key={instance.id} data-selected={String(instance.id === selectedId)} onClick={() => setSelectedId(instance.id)}>
            <td>
              <span className="fb-name">{instance.name}</span>
              <span className="fb-sub">{instance.baseUrl}</span>
            </td>
            <td>
              <span>{instance.authMode === 'api_key' ? 'API Key' : (zh ? '登录授权' : 'Sign-in')}</span>
              <span className="fb-sub">{instance.loginIdentifier ?? (instance.workspaceId === null ? (zh ? '长期 Token' : 'Durable token') : `ws ${shortId(instance.workspaceId)}`)}</span>
            </td>
            <td>{instance.models.length}</td>
            <td>{instance.mcps.length}</td>
            <td>
              <div className="fb-actions">
                <button className="fb-btn" onClick={event => { event.stopPropagation(); void test(instance) }} disabled={busy !== undefined}>
                  {busy === `test:${instance.id}` ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试' : 'Test')}
                </button>
                <button className="fb-btn" data-danger="true" onClick={event => { event.stopPropagation(); void remove(instance) }} disabled={busy !== undefined}>
                  {zh ? '删除' : 'Delete'}
                </button>
              </div>
            </td>
          </tr>)}
        </tbody>
      </table>
      {loading ? <div className="fb-empty">{zh ? '正在加载实例…' : 'Loading instances…'}</div> : null}
      {!loading && instances.length === 0 ? <div className="fb-empty">
        {zh ? '还没有 1flowbase 实例。点击「新建实例」开始。' : 'No 1flowbase instances yet. Create one to begin.'}
      </div> : null}
    </div>

    {selected === undefined ? null : <div className="fb-detail">
      <div className="fb-detail-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{selected.name}</h3>
          <span className="fb-sub">{selected.baseUrl} · {selected.authMode === 'api_key' ? 'API Key' : (zh ? '登录授权' : 'Sign-in')}</span>
        </div>
        <span className="fb-tag">{detailLoading ? (zh ? '加载中' : 'Loading') : `${String(applications.length)} apps / ${String(mcps.length)} MCP`}</span>
      </div>
      <div className="fb-columns">
        <div className="fb-card">
          <h4>{zh ? 'Agent Flow 应用 → 模型' : 'Agent-flow apps → models'}</h4>
          {detailLoading ? <div className="fb-empty">{zh ? '正在读取…' : 'Loading…'}</div> : applications.length === 0 ? <div className="fb-empty">
            {zh ? '当前凭据下没有 Agent Flow 应用。' : 'No agent-flow applications visible to this credential.'}
          </div> : <ul className="fb-list">
            {applications.map(application => <li className="fb-item" key={application.id}>
              <div className="fb-item-main">
                <span className="fb-item-name">{application.name}<span className="fb-tag">{application.imported ? (zh ? '已导入' : 'Imported') : (zh ? '未导入' : 'Available')}</span></span>
                <span className="fb-item-meta">
                  {application.imported && application.importedModel !== null
                    ? `${application.importedModel.wireModel} · ${String(application.importedModel.contextWindow)} ctx`
                    : application.description.length > 0 ? application.description : application.id}
                </span>
              </div>
              <button
                className="fb-btn"
                data-primary={application.imported ? undefined : 'true'}
                data-danger={application.imported ? 'true' : undefined}
                onClick={() => { void (application.imported ? removeApplication(application) : importApplication(application)) }}
                disabled={busy !== undefined}
              >
                {busy === `app:${application.id}` ? (zh ? '处理中…' : 'Working…') : application.imported ? (zh ? '移除' : 'Remove') : (zh ? '导入' : 'Import')}
              </button>
            </li>)}
          </ul>}
        </div>

        <div className="fb-card">
          <h4>{zh ? 'MCP 实例 → 连接器工具' : 'MCP instances → connector tools'}</h4>
          {detailLoading ? <div className="fb-empty">{zh ? '正在读取…' : 'Loading…'}</div> : mcps.length === 0 ? <div className="fb-empty">
            {zh ? '当前工作区没有 MCP 实例。' : 'No MCP instances in this workspace.'}
          </div> : <ul className="fb-list">
            {mcps.map(mcp => <li className="fb-item" key={mcp.instanceId}>
              <div className="fb-item-main">
                <span className="fb-item-name">{mcp.name}<span className="fb-tag">{mcp.enabled ? (zh ? '已启用' : 'Enabled') : mcp.status}</span></span>
                <span className="fb-item-meta fb-mono">{mcp.enabled ? `mcp__${mcp.serverName}__*` : `${mcp.instanceId} · ${mcp.description}`}</span>
              </div>
              <button
                className="fb-btn"
                data-primary={mcp.enabled ? undefined : 'true'}
                data-danger={mcp.enabled ? 'true' : undefined}
                onClick={() => { void toggleMcp(mcp) }}
                disabled={busy !== undefined}
              >
                {busy === `mcp:${mcp.instanceId}` ? (zh ? '连接中…' : 'Connecting…') : mcp.enabled ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}
              </button>
            </li>)}
          </ul>}
        </div>
      </div>
    </div>}

    {createOpen ? <CreateInstanceDialog onClose={() => setCreateOpen(false)} onCreated={created => {
      setCreateOpen(false)
      setNotice(zh ? `实例「${created.name}」已创建。` : `Instance "${created.name}" created.`)
      void loadInstances().then(list => {
        if (list.some(instance => instance.id === created.id)) setSelectedId(created.id)
      })
    }} /> : null}
  </section>
}

/** Inject the plugin stylesheet once per document. */
export function installStyles(): () => void {
  const existing = document.querySelector('style[data-plugin="1flowbase-dsh-plugin"]')
  if (existing !== null) return () => undefined
  const tag = document.createElement('style')
  tag.dataset.plugin = '1flowbase-dsh-plugin'
  tag.textContent = STYLES
  document.head.appendChild(tag)
  return () => tag.remove()
}
