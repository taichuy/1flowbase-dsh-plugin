import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApplicationProtocol, ApplicationProtocolSettings, ApplicationView } from '../shared/api.js'
import type { Copy } from './copy.js'

const PROTOCOLS: readonly ApplicationProtocol[] = ['chat-completions', 'responses', 'anthropic-messages']

export function protocolLabel(t: Copy, protocol: ApplicationProtocol): string {
  const labels: Record<ApplicationProtocol, string> = {
    'chat-completions': t.protocolChat,
    responses: t.protocolResponses,
    'anthropic-messages': t.protocolAnthropic,
  }
  return labels[protocol]
}

export function ApplicationDialog({ t, application, onClose, onSave }: {
  t: Copy
  application: ApplicationView
  onClose: () => void
  onSave: (settings: ApplicationProtocolSettings) => Promise<void>
}) {
  const [protocol, setProtocol] = useState<ApplicationProtocol>(application.importedApplication?.protocol ?? 'chat-completions')
  const [remoteCompaction, setRemoteCompaction] = useState(application.importedApplication?.remoteCompaction ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onSave({ protocol, remoteCompaction })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return <Modal
    open
    title={application.imported ? t.editApplicationTitle(application.name) : t.importApplicationTitle(application.name)}
    description={t.applicationProtocolHint}
    closeLabel={t.close}
    onClose={busy ? () => undefined : onClose}
    footer={<>
      <Button variant="outline" disabled={busy} onClick={onClose}>{t.cancel}</Button>
      <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>
        {busy ? t.working : application.imported ? t.save : t.importAction}
      </Button>
    </>}
  >
    <form className="fb-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label className="fb-field">
        <span>{t.protocolLabel}</span>
        <select className="fb-select" data-modal-autofocus disabled={busy} value={protocol}
          onChange={event => { setProtocol(event.target.value as ApplicationProtocol) }}>
          {PROTOCOLS.map(value => <option key={value} value={value}>{protocolLabel(t, value)}</option>)}
        </select>
      </label>
      {protocol === 'responses' ? <>
        <p className="fb-hint">{t.responsesTransportHint}</p>
        <label>
          <input type="checkbox" disabled={busy} checked={remoteCompaction}
            onChange={event => { setRemoteCompaction(event.target.checked) }} />
          {t.remoteCompactionLabel}
        </label>
      </> : null}
      {error === undefined ? null : <p className="fb-error" role="alert">{error}</p>}
    </form>
  </Modal>
}
