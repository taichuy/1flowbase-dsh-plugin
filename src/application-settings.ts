import type { ApplicationProtocolSettings } from './shared/api.js'
import { FlowbaseError } from './errors.js'

export function applicationSettings(value: unknown): ApplicationProtocolSettings {
  if (value === undefined) return { protocol: 'chat-completions', remoteCompaction: true }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FlowbaseError('request/invalid', 'Application settings must be an object')
  }
  const raw = value as Record<string, unknown>
  const protocol = raw.protocol ?? 'chat-completions'
  if (protocol !== 'chat-completions' && protocol !== 'responses' && protocol !== 'anthropic-messages') {
    throw new FlowbaseError('request/invalid', 'Unsupported application protocol')
  }
  if (raw.remoteCompaction !== undefined && typeof raw.remoteCompaction !== 'boolean') {
    throw new FlowbaseError('request/invalid', 'remoteCompaction must be a boolean')
  }
  return { protocol, remoteCompaction: raw.remoteCompaction ?? true }
}
