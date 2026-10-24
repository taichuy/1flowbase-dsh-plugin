import { readFileSync } from 'node:fs'
import { arch, platform, release, type } from 'node:os'
import { loadHostModule } from './host-module.js'

const host = await loadHostModule('@deepseek-ai/dsh-llm') as { userAgent(): string }

/** Public OS identity only; never include hostname, user name or local paths. */
export function operatingSystemName(system: string, kernel: string, osRelease?: string): string {
  if (system === 'Linux' && osRelease !== undefined) {
    const fields = new Map(osRelease.split('\n').flatMap(line => {
      const match = /^(NAME|VERSION_ID)=(.*)$/u.exec(line)
      if (!match) return []
      const value = match[2]!.replace(/^(["'])(.*)\1$/u, '$2')
      return [[match[1]!, value] as const]
    }))
    const name = fields.get('NAME')
    const version = fields.get('VERSION_ID')
    if (name && version && !/[\r\n\x00-\x1f()]/u.test(name + version)) return `${name} ${version}`
  }
  return `${system} ${kernel}`
}

export function formatUserAgent(hostIdentity: string, system: string, architecture: string): string {
  const cpu = architecture === 'x64' ? 'x86_64' : architecture
  const split = hostIdentity.indexOf(' ')
  const product = split < 0 ? hostIdentity : hostIdentity.slice(0, split)
  const comment = split < 0 ? '' : hostIdentity.slice(split)
  return `${product} (${system}; ${cpu})${comment}`
}

let distribution: string | undefined
if (platform() === 'linux') {
  try { distribution = readFileSync('/etc/os-release', 'utf8') } catch { /* Use real kernel identity on other Linux environments. */ }
}
const identity = formatUserAgent(host.userAgent(), operatingSystemName(type(), release(), distribution), arch())

/** Retain the running host's product/version and add actual OS/architecture. */
export function hostAttributionHeaders(): Record<string, string> {
  return { 'user-agent': identity }
}
