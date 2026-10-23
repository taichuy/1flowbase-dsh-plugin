// @vitest-environment jsdom
/**
 * Page-level tests for the 1flowbase settings section.
 *
 * The UI primitives ship with the shell (frozen module table), so this suite
 * stubs them with the same DOM contract and exercises the page's own logic:
 * drill-down, tab switching, grouping, and the exact write payloads. The real
 * primitives — modal layering and Escape ownership included — are covered by
 * the Playwright run against a real `dsh web` profile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FlowbasePanel } from '../src/client/panel.js'
import type { ApplicationView, InstanceView, McpInstanceView } from '../src/shared/api.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  const h = React.createElement
  const noopIcon = (): null => null
  return {
    Button: ({ icon, children, ...rest }: Record<string, unknown>) => h('button', { type: 'button', ...rest }, icon as never, children as never),
    Input: (props: Record<string, unknown>) => h('input', props),
    Tag: ({ children }: Record<string, unknown>) => h('span', {}, children as never),
    Switch: ({ checked, onChange, label, disabled }: Record<string, unknown>) => h('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      disabled,
      onClick: () => { (onChange as (next: boolean) => void)(!(checked as boolean)) },
    }),
    SegmentedControl: ({ value, options, onChange, label }: Record<string, unknown>) => h(
      'div',
      { role: 'tablist', 'aria-label': label },
      (options as { value: string; label: string; disabled?: boolean }[]).map(option => h(
        'button',
        {
          key: option.value,
          type: 'button',
          role: 'tab',
          'aria-selected': option.value === value,
          disabled: option.disabled,
          onClick: () => { (onChange as (next: string) => void)(option.value) },
        },
        option.label,
      )),
    ),
    SegmentedTabs: ({ items, value, onChange, label }: Record<string, unknown>) => h(
      'div',
      { role: 'tablist', 'aria-label': label },
      (items as { value: string; label: string; id: string; panelId: string }[]).map(item => h(
        'button',
        {
          key: item.value,
          id: item.id,
          type: 'button',
          role: 'tab',
          'aria-selected': item.value === value,
          'aria-controls': item.panelId,
          onClick: () => { (onChange as (next: string) => void)(item.value) },
        },
        item.label,
      )),
    ),
    Modal: ({ open, onClose, title, closeLabel, children, footer }: Record<string, unknown>) => (open as boolean)
      ? h(
        'div',
        { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('button', { type: 'button', 'aria-label': closeLabel, onClick: onClose as () => void }, 'x'),
        children as never,
        footer as never,
      )
      : null,
    Menu: ({ open, anchor, items, onSelect }: Record<string, unknown>) => h(
      'span',
      {},
      anchor as never,
      (open as boolean)
        ? h(
          'div',
          { role: 'menu' },
          (items as { id: string; type?: string; label?: string }[])
            .filter(item => item.type !== 'separator')
            .map(item => h(
              'button',
              { key: item.id, type: 'button', role: 'menuitem', onClick: () => { (onSelect as (id: string) => void)(item.id) } },
              item.label,
            )),
        )
        : null,
    ),
    IconChevronLeftOutlineRegular: noopIcon,
    IconEllipsisOutlineRegular: noopIcon,
    IconPlusOutlineRegular: noopIcon,
    IconRefreshOutlineRegular: noopIcon,
  }
})

interface Route {
  method?: string
  path: string
  reply: unknown
  error?: string
}

function stubFetch(routes: readonly Route[]): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${path}`)
    const route = routes.find(entry => entry.path === path && (entry.method ?? 'GET') === method)
    if (route === undefined) throw new Error(`unexpected request ${method} ${path}`)
    return { json: async () => (route.error === undefined ? { ok: true, data: route.reply } : { ok: false, error: { message: route.error } }) } as unknown as Response
  }))
  return calls
}

function instanceFixture(): InstanceView {
  return {
    id: 'i-1',
    name: 'local-e2e',
    baseUrl: 'http://127.0.0.1:7800',
    authMode: 'api_key',
    workspaceId: null,
    loginIdentifier: null,
    createdAt: 'then',
    updatedAt: 'then',
    applications: [{
      applicationId: 'app-1',
      name: 'any',
      description: '',
      models: [
        { id: 'claude-opus-4-8', name: 'claude-opus-4-8', contextWindow: 200_000, maxTokens: 8_192 },
        { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', contextWindow: 256_000, maxTokens: 16_384 },
      ],
      importedAt: 'then',
      protocol: 'chat-completions',
      remoteCompaction: true,
    }],
    mcps: [{ mcpInstanceId: 'mcp-1', name: 'Frontstage', serverName: 'frontstage_mcp-1', enabledAt: 'then' }],
  }
}

const APPLICATIONS: ApplicationView[] = [
  { id: 'app-2', name: 'codex', description: '本地 codex 使用的', imported: false, importedApplication: null },
  {
    id: 'app-1',
    name: 'any',
    description: '',
    imported: true,
    importedApplication: {
      applicationId: 'app-1',
      name: 'any',
      description: '',
      models: [
        { id: 'claude-opus-4-8', name: 'claude-opus-4-8', contextWindow: 200_000, maxTokens: 8_192 },
        { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', contextWindow: 256_000, maxTokens: 16_384 },
      ],
      importedAt: 'then',
      protocol: 'chat-completions',
      remoteCompaction: true,
    },
  },
]

const MCPS: McpInstanceView[] = [
  { instanceId: 'mcp-1', name: 'Frontstage', description: 'browser ops', status: 'enabled', enabled: true, serverName: 'frontstage_mcp-1', enabledAt: 'then' },
  { instanceId: 'mcp-2', name: 'SSH verification', description: 'ssh checks', status: 'disabled', enabled: false, serverName: 'ssh_verification_mcp-2', enabledAt: null },
]

function pluginRoutes(extra: readonly Route[] = []): Route[] {
  return [
    { path: '/api/1flowbase/instances', reply: [instanceFixture()] },
    { path: '/api/1flowbase/instances/i-1/apps', reply: APPLICATIONS },
    { path: '/api/1flowbase/instances/i-1/mcps', reply: MCPS },
    ...extra,
  ]
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderPanel(): Promise<void> {
  render(<FlowbasePanel />)
  await screen.findByText('local-e2e')
}

async function openDetail(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Open instance local-e2e' }))
  await screen.findByRole('tab', { name: /Apps/ })
}

describe('1flowbase settings panel', () => {
  it('lists instances with their connected totals and drills into one instance', async () => {
    stubFetch(pluginRoutes())
    await renderPanel()
    expect(screen.getByText('1 app(s) · 2 model(s) · 1 MCP connector(s)')).toBeTruthy()

    await openDetail()
    expect(screen.getByText('http://127.0.0.1:7800 · API Key')).toBeTruthy()
    // Imported models are grouped ahead of the still-available ones.
    expect(screen.getByText('1 imported')).toBeTruthy()
    expect(screen.getByText('1 available')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy()
    // The imported application lists the whole catalogue it publishes.
    expect(screen.getByText('2 model(s) · claude-opus-4-8 · gpt-5.6-sol')).toBeTruthy()
  })

  it('returns to the list from the detail view', async () => {
    stubFetch(pluginRoutes())
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Instances' }))
    expect(await screen.findByText('1 instance(s)')).toBeTruthy()
  })

  it('enables a disabled MCP connector from its own tab', async () => {
    const calls = stubFetch(pluginRoutes([
      { method: 'POST', path: '/api/1flowbase/instances/i-1/mcps/mcp-2', reply: { ...MCPS[1], enabled: true } },
    ]))
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('tab', { name: /MCP/ }))

    const toggle = await screen.findByRole('switch', { name: 'Enable SSH verification' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => { expect(calls).toContain('POST /api/1flowbase/instances/i-1/mcps/mcp-2') })
    expect(await screen.findByText('Enabled MCP "SSH verification" as mcp__ssh_verification_mcp-2__*.')).toBeTruthy()
  })

  it('sends only the changed name and the rotated credential from the connection tab', async () => {
    const calls = stubFetch(pluginRoutes([
      { method: 'POST', path: '/api/1flowbase/instances/i-1/update', reply: { instance: instanceFixture(), warnings: [] } },
    ]))
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('tab', { name: 'Connection' }))

    fireEvent.change(await screen.findByLabelText('Instance name'), { target: { value: 'renamed' } })
    fireEvent.change(screen.getByLabelText('User API key'), { target: { value: 'rotated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => { expect(calls).toContain('POST /api/1flowbase/instances/i-1/update') })
    const updateCall = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .find(call => call[0] === '/api/1flowbase/instances/i-1/update')
    expect(JSON.parse(String(updateCall?.[1].body))).toEqual({
      name: 'renamed',
      baseUrl: 'http://127.0.0.1:7800',
      credential: { authMode: 'api_key', apiKey: 'rotated' },
    })
    expect(await screen.findByText('Credential replaced; enabled MCP connectors reconnected with it.')).toBeTruthy()
  })

  it('keeps the stored credential when only the name changes', async () => {
    const calls = stubFetch(pluginRoutes([
      { method: 'POST', path: '/api/1flowbase/instances/i-1/update', reply: { instance: instanceFixture(), warnings: [] } },
    ]))
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('tab', { name: 'Connection' }))
    fireEvent.change(await screen.findByLabelText('Instance name'), { target: { value: 'renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => { expect(calls).toContain('POST /api/1flowbase/instances/i-1/update') })
    const updateCall = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .find(call => call[0] === '/api/1flowbase/instances/i-1/update')
    expect(JSON.parse(String(updateCall?.[1].body))).toEqual({
      name: 'renamed',
      baseUrl: 'http://127.0.0.1:7800',
    })
  })

  it('validates the create form before calling the API', async () => {
    const calls = stubFetch(pluginRoutes())
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'New instance' }))
    expect(await screen.findByRole('dialog', { name: 'New 1flowbase instance' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create instance' }))
    expect(await screen.findByText('Instance name is required')).toBeTruthy()
    expect(calls.some(call => call.startsWith('POST /api/1flowbase/instances'))).toBe(false)
  })

  it('surfaces the update warning list without losing the saved instance', async () => {
    stubFetch(pluginRoutes([
      {
        method: 'POST',
        path: '/api/1flowbase/instances/i-1/update',
        reply: { instance: instanceFixture(), warnings: ['MCP「Frontstage」未能用新配置重新连接'] },
      },
    ]))
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('tab', { name: 'Connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/1 MCP connection\(s\) need re-enabling/)).toBeTruthy()
  })

  it('imports with the selected provider protocol and preserves compaction across protocol changes', async () => {
    const saved = { ...instanceFixture().applications[0], applicationId: 'app-2', name: 'codex', protocol: 'responses', remoteCompaction: false }
    const calls = stubFetch(pluginRoutes([
      { method: 'POST', path: '/api/1flowbase/instances/i-1/apps/app-2', reply: saved },
    ]))
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Import application "codex"' }))
    const protocol = dialog.getByLabelText('Application protocol') as HTMLSelectElement
    expect(protocol.value).toBe('chat-completions')
    expect(calls.some(call => call.startsWith('POST'))).toBe(false)
    fireEvent.change(protocol, { target: { value: 'responses' } })
    const compaction = dialog.getByRole('checkbox') as HTMLInputElement
    expect(compaction.checked).toBe(true)
    expect(dialog.getByText(/5 total connection failures/)).toBeTruthy()
    fireEvent.click(compaction)
    fireEvent.change(protocol, { target: { value: 'anthropic-messages' } })
    expect(dialog.queryByRole('checkbox')).toBeNull()
    fireEvent.change(protocol, { target: { value: 'responses' } })
    expect((dialog.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(dialog.getByRole('button', { name: 'Import' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    const request = vi.mocked(fetch).mock.calls.find(call => call[0] === '/api/1flowbase/instances/i-1/apps/app-2')
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ protocol: 'responses', remoteCompaction: false })
    fireEvent.click(screen.getByRole('button', { name: 'Edit application codex' }))
    expect((screen.getByLabelText('Application protocol') as HTMLSelectElement).value).toBe('responses')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('saves application settings and reopens the persisted values without importing again', async () => {
    const saved = { ...instanceFixture().applications[0], protocol: 'responses', remoteCompaction: false }
    const calls = stubFetch(pluginRoutes([
      { method: 'POST', path: '/api/1flowbase/instances/i-1/apps/app-1/update', reply: saved },
    ]))
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit application any' }))
    fireEvent.change(screen.getByLabelText('Application protocol'), { target: { value: 'responses' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/1flowbase/instances/i-1/apps/app-1/update'])
    const request = vi.mocked(fetch).mock.calls.find(call => call[0] === '/api/1flowbase/instances/i-1/apps/app-1/update')
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ protocol: 'responses', remoteCompaction: false })
    fireEvent.click(screen.getByRole('button', { name: 'Edit application any' }))
    expect((screen.getByLabelText('Application protocol') as HTMLSelectElement).value).toBe('responses')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('cancels application edits without requests or changing stored settings', async () => {
    const calls = stubFetch(pluginRoutes())
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit application any' }))
    fireEvent.change(screen.getByLabelText('Application protocol'), { target: { value: 'anthropic-messages' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.some(call => call.startsWith('POST'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Edit application any' }))
    expect((screen.getByLabelText('Application protocol') as HTMLSelectElement).value).toBe('chat-completions')
  })

  it('keeps the application draft and error visible when saving fails', async () => {
    stubFetch(pluginRoutes([
      { method: 'POST', path: '/api/1flowbase/instances/i-1/apps/app-1/update', reply: null, error: 'Protocol update failed' },
    ]))
    await renderPanel()
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit application any' }))
    fireEvent.change(screen.getByLabelText('Application protocol'), { target: { value: 'responses' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Protocol update failed')
    expect((screen.getByLabelText('Application protocol') as HTMLSelectElement).value).toBe('responses')
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

})
