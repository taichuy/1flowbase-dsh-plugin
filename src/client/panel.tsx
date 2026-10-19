import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  Menu,
  SegmentedTabs,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { flowbaseApi } from './api.js'
import { copyFor, isChinese } from './copy.js'
import type { Copy } from './copy.js'
import { ConnectionForm, CreateInstanceDialog, DeleteInstanceDialog } from './forms.js'
import { STYLES } from './styles.js'
import type {
  ApplicationView,
  AuthMode,
  InstanceView,
  McpInstanceView,
  UpdateInstanceInput,
} from '../shared/api.js'

type Tab = 'models' | 'mcps' | 'connection'
type Status = { tone: 'ok' | 'warn' | 'error'; text: string }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function authLabel(t: Copy, authMode: AuthMode): string {
  return authMode === 'api_key' ? t.authApiKey : t.authLogin
}

function StatusBar({ status }: { status: Status | undefined }) {
  if (status === undefined) return null
  const className = status.tone === 'error' ? 'fb-error' : status.tone === 'warn' ? 'fb-warn' : 'fb-ok'
  return <p className={className} role="status">{status.text}</p>
}

function InstanceRows({ t, instances, busy, menuId, onMenu, onOpen, onTest, onDelete }: {
  t: Copy
  instances: InstanceView[]
  busy: string | undefined
  menuId: string | undefined
  onMenu: (id: string | undefined) => void
  onOpen: (id: string) => void
  onTest: (instance: InstanceView) => void
  onDelete: (id: string) => void
}) {
  if (instances.length === 0) {
    // The toolbar owns the only "new instance" action; the empty state stays a statement.
    return <p className="fb-empty-card fb-empty">{t.emptyInstances}</p>
  }
  return <ul className="fb-rows" aria-label={t.listAria}>
    {instances.map(instance => <li className="fb-row" key={instance.id}>
      <button
        type="button"
        className="fb-row-open"
        aria-label={t.openInstance(instance.name)}
        onClick={() => { onOpen(instance.id) }}
      >
        <span className="fb-row-head">
          <span className="fb-row-name">{instance.name}</span>
          <Tag tone="outline">{authLabel(t, instance.authMode)}</Tag>
        </span>
        <span className="fb-row-meta">{instance.baseUrl}</span>
        <span className="fb-row-summary">{t.summary(
          instance.applications.length,
          instance.applications.reduce((total, application) => total + application.models.length, 0),
          instance.mcps.length,
        )}</span>
      </button>
      <Menu
        open={menuId === instance.id}
        align="end"
        portal
        onClose={() => { onMenu(undefined) }}
        anchor={<Button
          variant="ghost"
          aria-label={t.moreActions(instance.name)}
          icon={<IconEllipsisOutlineRegular size={16} />}
          onClick={() => { onMenu(menuId === instance.id ? undefined : instance.id) }}
        />}
        items={[
          { id: 'open', label: t.open },
          { id: 'test', label: busy === `test:${instance.id}` ? t.testing : t.test, disabled: busy !== undefined },
          { id: 'remove', label: t.remove, danger: true, disabled: busy !== undefined },
        ]}
        onSelect={id => {
          onMenu(undefined)
          if (id === 'open') onOpen(instance.id)
          if (id === 'test') onTest(instance)
          if (id === 'remove') onDelete(instance.id)
        }}
      />
    </li>)}
  </ul>
}

function ApplicationRows({ t, applications, busy, onToggle }: {
  t: Copy
  applications: ApplicationView[]
  busy: string | undefined
  onToggle: (application: ApplicationView) => void
}) {
  const imported = applications.filter(application => application.imported)
  const available = applications.filter(application => !application.imported)
  const groups = imported.length === 0 || available.length === 0
    ? [{ key: 'all', title: undefined as string | undefined, items: applications }]
    : [
      { key: 'imported', title: t.groupImported(imported.length), items: imported },
      { key: 'available', title: t.groupAvailable(available.length), items: available },
    ]
  return <>
    {groups.map(group => <div className="fb-group" key={group.key}>
      {group.title === undefined ? null : <h3 className="fb-group-title">{group.title}</h3>}
      <ul className="fb-items">
        {group.items.map(application => <li className="fb-item" key={application.id}>
          <span className="fb-item-main">
            <span className="fb-item-title">
              {application.name}
              {application.imported ? <Tag tone="success">{t.tagImported}</Tag> : null}
            </span>
            <span className="fb-item-meta">
              {application.importedApplication !== null
                ? [
                  t.applicationModels(application.importedApplication.models.length),
                  application.importedApplication.models.map(model => model.id).join(' · '),
                ].join(' · ')
                : application.description}
            </span>
          </span>
          <Button
            variant="outline"
            size="sm"
            className={application.imported ? 'fb-btn-danger' : undefined}
            disabled={busy !== undefined}
            onClick={() => { onToggle(application) }}
          >
            {busy === `app:${application.id}`
              ? (application.imported ? t.removing : t.importing)
              : (application.imported ? t.removeAction : t.importAction)}
          </Button>
        </li>)}
      </ul>
    </div>)}
  </>
}

function McpRows({ t, mcps, busy, onToggle }: {
  t: Copy
  mcps: McpInstanceView[]
  busy: string | undefined
  onToggle: (mcp: McpInstanceView) => void
}) {
  return <ul className="fb-items">
    {mcps.map(mcp => <li className="fb-item" key={mcp.instanceId}>
      <span className="fb-item-main">
        <span className="fb-item-title">
          {mcp.name}
          <Tag tone={mcp.enabled ? 'success' : 'neutral'}>{mcp.enabled ? t.tagEnabled : t.tagDisabled}</Tag>
        </span>
        <span className="fb-item-meta fb-mono">
          {mcp.enabled ? `mcp__${mcp.serverName}__*` : mcp.description}
        </span>
      </span>
      <Switch
        checked={mcp.enabled}
        disabled={busy !== undefined}
        label={`${mcp.enabled ? t.disableAction : t.enableAction} ${mcp.name}`}
        onChange={() => { onToggle(mcp) }}
      />
    </li>)}
  </ul>
}

export function FlowbasePanel() {
  const t = copyFor(isChinese())
  const [instances, setInstances] = useState<InstanceView[]>([])
  const [openId, setOpenId] = useState<string | undefined>()
  const [applications, setApplications] = useState<ApplicationView[]>([])
  const [mcps, setMcps] = useState<McpInstanceView[]>([])
  const [tab, setTab] = useState<Tab>('models')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [status, setStatus] = useState<Status>()
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string>()
  const [menuId, setMenuId] = useState<string>()

  const open = instances.find(instance => instance.id === openId)
  const deleteTarget = instances.find(instance => instance.id === deleteId)

  const loadInstances = useCallback(async (): Promise<InstanceView[]> => {
    const list = await flowbaseApi.listInstances()
    setInstances(list)
    setOpenId(current => current !== undefined && !list.some(instance => instance.id === current) ? undefined : current)
    return list
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await flowbaseApi.listInstances()
        if (!cancelled) setInstances(list)
      } catch (failure) {
        if (!cancelled) setStatus({ tone: 'error', text: errorText(failure) })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (openId === undefined) {
      setApplications([])
      setMcps([])
      return
    }
    let cancelled = false
    setDetailLoading(true)
    void (async () => {
      try {
        const [appList, mcpList] = await Promise.all([
          flowbaseApi.listApplications(openId),
          flowbaseApi.listMcps(openId),
        ])
        if (cancelled) return
        setApplications(appList)
        setMcps(mcpList)
      } catch (failure) {
        if (!cancelled) setStatus({ tone: 'error', text: errorText(failure) })
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [openId])

  const openInstance = (id: string): void => {
    setOpenId(id)
    setTab('models')
    setStatus(undefined)
  }

  const refreshAll = async (): Promise<void> => {
    setBusy('refresh')
    setStatus(undefined)
    try {
      const list = await loadInstances()
      const id = openId !== undefined && list.some(instance => instance.id === openId) ? openId : undefined
      if (id !== undefined) {
        const [appList, mcpList] = await Promise.all([flowbaseApi.listApplications(id), flowbaseApi.listMcps(id)])
        setApplications(appList)
        setMcps(mcpList)
      }
    } catch (failure) {
      setStatus({ tone: 'error', text: errorText(failure) })
    } finally {
      setBusy(undefined)
    }
  }

  const test = async (instance: InstanceView): Promise<void> => {
    setBusy(`test:${instance.id}`)
    setStatus(undefined)
    try {
      const result = await flowbaseApi.testInstance(instance.id)
      setStatus({
        tone: 'ok',
        text: t.testOk(instance.name, result.applicationCount ?? 0, result.mcpInstanceCount ?? 0),
      })
    } catch (failure) {
      setStatus({ tone: 'error', text: errorText(failure) })
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (instance: InstanceView): Promise<void> => {
    setDeleteId(undefined)
    setBusy(`delete:${instance.id}`)
    setStatus(undefined)
    try {
      await flowbaseApi.deleteInstance(instance.id)
      await loadInstances()
      setStatus({ tone: 'ok', text: t.deleted(instance.name) })
    } catch (failure) {
      setStatus({ tone: 'error', text: errorText(failure) })
    } finally {
      setBusy(undefined)
    }
  }

  const update = async (id: string, patch: UpdateInstanceInput): Promise<void> => {
    setBusy(`update:${id}`)
    setStatus(undefined)
    try {
      const result = await flowbaseApi.updateInstance(id, patch)
      setInstances(current => current.map(entry => entry.id === id ? result.instance : entry))
      setStatus(result.warnings.length === 0
        ? { tone: 'ok', text: patch.credential === undefined ? t.updated : t.credentialReplaced }
        : { tone: 'warn', text: `${t.updateWarning(result.warnings.length)} ${result.warnings.join(' ')}` })
    } finally {
      setBusy(undefined)
    }
  }

  const toggleApplication = async (application: ApplicationView): Promise<void> => {
    if (openId === undefined) return
    setBusy(`app:${application.id}`)
    setStatus(undefined)
    try {
      if (application.imported) {
        await flowbaseApi.removeApplication(openId, application.id)
        setStatus({ tone: 'ok', text: t.removed(application.name) })
      } else {
        await flowbaseApi.importApplication(openId, application.id)
        setStatus({ tone: 'ok', text: t.imported(application.name) })
      }
      setApplications(await flowbaseApi.listApplications(openId))
      await loadInstances()
    } catch (failure) {
      setStatus({ tone: 'error', text: errorText(failure) })
    } finally {
      setBusy(undefined)
    }
  }

  const toggleMcp = async (mcp: McpInstanceView): Promise<void> => {
    if (openId === undefined) return
    setBusy(`mcp:${mcp.instanceId}`)
    setStatus(undefined)
    try {
      if (mcp.enabled) {
        await flowbaseApi.disableMcp(openId, mcp.instanceId)
        setStatus({ tone: 'ok', text: t.disabled(mcp.name) })
      } else {
        await flowbaseApi.enableMcp(openId, mcp.instanceId)
        setStatus({ tone: 'ok', text: t.enabled(mcp.name, mcp.serverName) })
      }
      setMcps(await flowbaseApi.listMcps(openId))
      await loadInstances()
    } catch (failure) {
      setStatus({ tone: 'error', text: errorText(failure) })
    } finally {
      setBusy(undefined)
    }
  }

  const tabs: readonly [SegmentedTab<Tab>, ...SegmentedTab<Tab>[]] = [
    {
      value: 'models',
      label: `${t.tabApplications} ${String(open?.applications.length ?? 0)}/${String(applications.length)}`,
      id: 'fb-tab-models',
      panelId: 'fb-panel-models',
    },
    {
      value: 'mcps',
      label: `${t.tabMcps} ${String(open?.mcps.length ?? 0)}/${String(mcps.length)}`,
      id: 'fb-tab-mcps',
      panelId: 'fb-panel-mcps',
    },
    { value: 'connection', label: t.tabConnection, id: 'fb-tab-connection', panelId: 'fb-panel-connection' },
  ]

  return <section className="fb-section">
    {open === undefined ? <>
      <h2>{t.listTitle}</h2>
      <p className="fb-hint">{t.listHint}</p>
      <StatusBar status={status} />
      <div className="fb-toolbar">
        <Button
          variant="primary"
          icon={<IconPlusOutlineRegular size={16} />}
          disabled={busy !== undefined}
          onClick={() => { setCreateOpen(true) }}
        >
          {t.newInstance}
        </Button>
        <Button
          variant="outline"
          icon={<IconRefreshOutlineRegular size={16} />}
          disabled={busy !== undefined}
          onClick={() => { void refreshAll() }}
        >
          {busy === 'refresh' ? t.refreshing : t.refresh}
        </Button>
        <span className="fb-spacer" />
        <span className="fb-count">{t.instanceCount(instances.length)}</span>
      </div>
      {loading
        ? <p className="fb-empty">{t.loadingInstances}</p>
        : <InstanceRows
          t={t}
          instances={instances}
          busy={busy}
          menuId={menuId}
          onMenu={setMenuId}
          onOpen={openInstance}
          onTest={instance => { void test(instance) }}
          onDelete={setDeleteId}
        />}
    </> : <>
      <div className="fb-detail-bar">
        <Button
          variant="ghost"
          size="sm"
          icon={<IconChevronLeftOutlineRegular size={16} />}
          onClick={() => { setOpenId(undefined); setStatus(undefined) }}
        >
          {t.back}
        </Button>
        <span className="fb-detail-identity">
          <span className="fb-row-name">{open.name}</span>
          <span className="fb-row-meta">{open.baseUrl} · {authLabel(t, open.authMode)}</span>
        </span>
        <span className="fb-detail-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== undefined}
            onClick={() => { void test(open) }}
          >
            {busy === `test:${open.id}` ? t.testing : t.test}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={tab === 'connection'}
            onClick={() => { setTab('connection') }}
          >
            {t.edit}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="fb-btn-danger"
            disabled={busy !== undefined}
            onClick={() => { setDeleteId(open.id) }}
          >
            {t.remove}
          </Button>
        </span>
      </div>
      <StatusBar status={status} />
      <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t.tabsLabel} />
      <div id="fb-panel-models" role="tabpanel" aria-labelledby="fb-tab-models" hidden={tab !== 'models'} className="fb-panel">
        {detailLoading
          ? <p className="fb-empty">{t.loading}</p>
          : applications.length === 0
            ? <p className="fb-empty">{t.noApplications}</p>
            : <ApplicationRows
              t={t}
              applications={applications}
              busy={busy}
              onToggle={application => { void toggleApplication(application) }}
            />}
      </div>
      <div id="fb-panel-mcps" role="tabpanel" aria-labelledby="fb-tab-mcps" hidden={tab !== 'mcps'} className="fb-panel">
        {detailLoading
          ? <p className="fb-empty">{t.loading}</p>
          : mcps.length === 0
            ? <p className="fb-empty">{t.noMcps}</p>
            : <McpRows t={t} mcps={mcps} busy={busy} onToggle={mcp => { void toggleMcp(mcp) }} />}
      </div>
      <div id="fb-panel-connection" role="tabpanel" aria-labelledby="fb-tab-connection" hidden={tab !== 'connection'} className="fb-panel">
        <ConnectionForm
          t={t}
          instance={open}
          busy={busy === `update:${open.id}`}
          onSubmit={patch => update(open.id, patch)}
        />
      </div>
    </>}

    {createOpen ? <CreateInstanceDialog
      t={t}
      onClose={() => { setCreateOpen(false) }}
      onCreated={created => {
        setCreateOpen(false)
        setStatus({ tone: 'ok', text: t.created(created.name) })
        void loadInstances().then(() => { setOpenId(created.id) })
      }}
    /> : null}

    {deleteTarget === undefined ? null : <DeleteInstanceDialog
      t={t}
      instance={deleteTarget}
      onCancel={() => { setDeleteId(undefined) }}
      onConfirm={() => { void remove(deleteTarget) }}
    />}
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
