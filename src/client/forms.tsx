import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { flowbaseApi } from './api.js'
import type { Copy } from './copy.js'
import type {
  AuthMode,
  CreateInstanceInput,
  ExpirationPolicy,
  InstanceView,
  UpdateInstanceInput,
} from '../shared/api.js'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One labelled control row; the shell owns nothing here, so the page labels it. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="fb-field"><span>{label}</span>{children}</label>
}

function AuthModeControl({ t, id, value, onChange, disabled }: {
  t: Copy
  id: string
  value: AuthMode
  onChange: (mode: AuthMode) => void
  disabled?: boolean
}) {
  return <SegmentedControl
    id={id}
    label={t.fieldAuth}
    value={value}
    options={[
      { value: 'api_key', label: t.authApiKey },
      { value: 'login', label: t.authLogin },
    ]}
    onChange={onChange}
    {...disabled === undefined ? {} : { disabled }}
  />
}

const EXPIRATION_OPTIONS: readonly ExpirationPolicy[] = ['30d', '1y', '3y', 'never']

function ExpirationSelect({ t, value, onChange }: {
  t: Copy
  value: ExpirationPolicy
  onChange: (policy: ExpirationPolicy) => void
}) {
  const labels: Record<ExpirationPolicy, string> = {
    '30d': t.expiration30d,
    '1y': t.expiration1y,
    '3y': t.expiration3y,
    never: t.expirationNever,
  }
  return <select className="fb-select" value={value} onChange={event => {
    onChange(event.target.value as ExpirationPolicy)
  }}>
    {EXPIRATION_OPTIONS.map(option => <option key={option} value={option}>{labels[option]}</option>)}
  </select>
}

export function CreateInstanceDialog({ t, onClose, onCreated }: {
  t: Copy
  onClose: () => void
  onCreated: (instance: InstanceView) => void
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:7800')
  const [authMode, setAuthMode] = useState<AuthMode>('api_key')
  const [apiKey, setApiKey] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [roleCode, setRoleCode] = useState('')
  const [expirationPolicy, setExpirationPolicy] = useState<ExpirationPolicy>('1y')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      if (name.trim().length === 0) throw new Error(t.errorNameRequired)
      if (baseUrl.trim().length === 0) throw new Error(t.errorBaseUrlRequired)
      if (authMode === 'api_key' && apiKey.trim().length === 0) throw new Error(t.errorApiKeyRequired)
      if (authMode === 'login' && (identifier.trim().length === 0 || password.length === 0)) {
        throw new Error(t.errorCredentialRequired)
      }
      const input: CreateInstanceInput = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authMode,
        ...(authMode === 'api_key' ? { apiKey: apiKey.trim() } : {
          identifier: identifier.trim(),
          password,
          ...(roleCode.trim().length === 0 ? {} : { roleCode: roleCode.trim() }),
          expirationPolicy,
        }),
      }
      onCreated(await flowbaseApi.createInstance(input))
    } catch (failure) {
      setError(errorText(failure))
      setBusy(false)
    }
  }

  return <Modal
    open
    onClose={busy ? () => undefined : onClose}
    title={t.createTitle}
    description={t.createDescription}
    closeLabel={t.close}
    footer={<>
      <Button variant="outline" onClick={onClose} disabled={busy}>{t.cancel}</Button>
      <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>
        {busy ? t.creating : t.createSubmit}
      </Button>
    </>}
  >
    <form className="fb-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <Field label={t.fieldName}>
        <Input
          data-modal-autofocus
          value={name}
          placeholder={t.fieldNamePlaceholder}
          onChange={event => { setName(event.target.value) }}
        />
      </Field>
      <Field label={t.fieldBaseUrl}>
        <Input
          value={baseUrl}
          placeholder="https://1flowbase.example.com"
          spellCheck={false}
          onChange={event => { setBaseUrl(event.target.value) }}
        />
      </Field>
      <div className="fb-field">
        <span>{t.fieldAuth}</span>
        <AuthModeControl t={t} id="fb-create-auth" value={authMode} onChange={setAuthMode} disabled={busy} />
      </div>
      {authMode === 'api_key'
        ? <Field label={t.fieldApiKey}>
          <Input
            type="password"
            value={apiKey}
            placeholder={t.fieldApiKeyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            onChange={event => { setApiKey(event.target.value) }}
          />
        </Field>
        : <>
          <Field label={t.fieldIdentifier}>
            <Input value={identifier} autoComplete="username" spellCheck={false} onChange={event => { setIdentifier(event.target.value) }} />
          </Field>
          <Field label={t.fieldPassword}>
            <Input type="password" value={password} autoComplete="current-password" onChange={event => { setPassword(event.target.value) }} />
          </Field>
          <Field label={t.fieldRoleCode}>
            <Input value={roleCode} placeholder={t.fieldRoleCodePlaceholder} spellCheck={false} onChange={event => { setRoleCode(event.target.value) }} />
          </Field>
          <Field label={t.fieldExpiration}>
            <ExpirationSelect t={t} value={expirationPolicy} onChange={setExpirationPolicy} />
          </Field>
          <p className="fb-hint">{t.loginNote}</p>
        </>}
      {error === undefined ? null : <p className="fb-error" role="alert">{error}</p>}
    </form>
  </Modal>
}

export function DeleteInstanceDialog({ t, instance, onCancel, onConfirm }: {
  t: Copy
  instance: InstanceView
  onCancel: () => void
  onConfirm: () => void
}) {
  return <Modal
    open
    onClose={onCancel}
    title={t.deleteTitle(instance.name)}
    description={t.deleteBody}
    closeLabel={t.close}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onCancel}>{t.cancel}</Button>
      <Button variant="ghost" className="fb-btn-danger" onClick={onConfirm}>{t.deleteConfirm}</Button>
    </>}
  >
    <p className="fb-hint">{instance.baseUrl}</p>
  </Modal>
}

/** Connection editor: rename, move the address, or replace the stored credential. */
export function ConnectionForm({ t, instance, busy, onSubmit }: {
  t: Copy
  instance: InstanceView
  busy: boolean
  onSubmit: (patch: UpdateInstanceInput) => Promise<void>
}) {
  const [name, setName] = useState(instance.name)
  const [baseUrl, setBaseUrl] = useState(instance.baseUrl)
  const [authMode, setAuthMode] = useState<AuthMode>(instance.authMode)
  const [apiKey, setApiKey] = useState('')
  const [identifier, setIdentifier] = useState(instance.loginIdentifier ?? '')
  const [password, setPassword] = useState('')
  const [roleCode, setRoleCode] = useState('')
  const [expirationPolicy, setExpirationPolicy] = useState<ExpirationPolicy>('1y')
  const [error, setError] = useState<string>()

  // A saved instance (or a different one) resets the draft, including secrets.
  useEffect(() => {
    setName(instance.name)
    setBaseUrl(instance.baseUrl)
    setAuthMode(instance.authMode)
    setIdentifier(instance.loginIdentifier ?? '')
    setApiKey('')
    setPassword('')
    setRoleCode('')
    setError(undefined)
  }, [instance.id, instance.name, instance.baseUrl, instance.authMode, instance.loginIdentifier])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    try {
      if (name.trim().length === 0) throw new Error(t.errorNameRequired)
      if (baseUrl.trim().length === 0) throw new Error(t.errorBaseUrlRequired)
      const supplied = apiKey.trim().length > 0 || identifier.trim().length > 0 || password.length > 0
      const credentialRequired = authMode !== instance.authMode || supplied
      const patch: UpdateInstanceInput = { name: name.trim(), baseUrl: baseUrl.trim() }
      if (credentialRequired) {
        if (authMode === 'api_key') {
          if (apiKey.trim().length === 0) throw new Error(t.errorApiKeyRequired)
          patch.credential = { authMode: 'api_key', apiKey: apiKey.trim() }
        } else {
          if (identifier.trim().length === 0 || password.length === 0) throw new Error(t.errorCredentialRequired)
          patch.credential = {
            authMode: 'login',
            identifier: identifier.trim(),
            password,
            ...(roleCode.trim().length === 0 ? {} : { roleCode: roleCode.trim() }),
            expirationPolicy,
          }
        }
      }
      await onSubmit(patch)
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  return <form className="fb-form fb-form-inline" onSubmit={event => { void submit(event) }}>
    <Field label={t.fieldName}>
      <Input value={name} disabled={busy} onChange={event => { setName(event.target.value) }} />
    </Field>
    <Field label={t.fieldBaseUrl}>
      <Input value={baseUrl} disabled={busy} spellCheck={false} onChange={event => { setBaseUrl(event.target.value) }} />
    </Field>
    <div className="fb-field">
      <span>{t.fieldAuth}</span>
      <AuthModeControl t={t} id="fb-connection-auth" value={authMode} onChange={next => {
        setAuthMode(next)
        setApiKey('')
        setPassword('')
      }} disabled={busy} />
    </div>
    {authMode === 'api_key'
      ? <Field label={t.fieldApiKey}>
        <Input
          type="password"
          value={apiKey}
          disabled={busy}
          placeholder={t.keepCredentialHint}
          autoComplete="off"
          spellCheck={false}
          onChange={event => { setApiKey(event.target.value) }}
        />
      </Field>
      : <>
        <Field label={t.fieldIdentifier}>
          <Input value={identifier} disabled={busy} autoComplete="username" spellCheck={false} onChange={event => { setIdentifier(event.target.value) }} />
        </Field>
        <Field label={t.fieldPassword}>
          <Input type="password" value={password} disabled={busy} placeholder={t.keepCredentialHint} autoComplete="current-password" onChange={event => { setPassword(event.target.value) }} />
        </Field>
        <Field label={t.fieldRoleCode}>
          <Input value={roleCode} disabled={busy} placeholder={t.fieldRoleCodePlaceholder} spellCheck={false} onChange={event => { setRoleCode(event.target.value) }} />
        </Field>
        <Field label={t.fieldExpiration}>
          <ExpirationSelect t={t} value={expirationPolicy} onChange={setExpirationPolicy} />
        </Field>
      </>}
    <p className="fb-hint">{t.connectionHint}</p>
    {error === undefined ? null : <p className="fb-error" role="alert">{error}</p>}
    <div className="fb-form-actions">
      <Button variant="primary" type="submit" disabled={busy}>
        {busy ? t.saving : t.save}
      </Button>
    </div>
  </form>
}
