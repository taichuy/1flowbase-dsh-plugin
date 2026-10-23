import { createRequire, findPackageJSON } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Select only Node's public ESM conditions, respecting package key order. */
function importTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = importTarget(candidate)
      if (selected !== undefined) return selected
    }
  } else if (record(value)) {
    for (const [condition, candidate] of Object.entries(value)) {
      if (condition === 'import' || condition === 'node' || condition === 'default') {
        const selected = importTarget(candidate)
        if (selected !== undefined) return selected
      }
    }
  }
  return undefined
}

/** Resolve an import-only export from the host's package, never a private SDK path. */
function hostImportUrl(name: string, hostUrl: URL): string | undefined {
  const parts = name.split('/')
  const packageName = parts.slice(0, name.startsWith('@') ? 2 : 1).join('/')
  let manifest: string | undefined
  try {
    manifest = findPackageJSON(packageName, hostUrl)
  } catch (error) {
    if (errorCode(error) === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  }
  if (manifest === undefined) return undefined
  const data: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  const exports = record(data) ? data.exports : undefined
  const subpath = name === packageName ? '.' : `.${name.slice(packageName.length)}`
  let target: string | undefined
  if (record(exports) && Object.keys(exports).some(key => key.startsWith('.'))) {
    if (Object.hasOwn(exports, subpath)) target = importTarget(exports[subpath])
    else {
      // Node prioritizes the longest prefix, then the longest pattern key.
      const patterns = Object.keys(exports).filter(key => key.includes('*')).sort((a, b) =>
        b.indexOf('*') - a.indexOf('*') || b.length - a.length)
      for (const pattern of patterns) {
        const [prefix = '', suffix = ''] = pattern.split('*')
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) continue
        const match = subpath.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length)
        target = importTarget(exports[pattern])?.replaceAll('*', match)
        break
      }
    }
  } else if (subpath === '.') target = importTarget(exports)
  if (target === undefined || !target.startsWith('./') || target.split('/').some(part => part === '..' || part === 'node_modules')) {
    throw new Error(`Host package ${packageName} does not expose a supported public import for ${subpath}`)
  }
  return new URL(target, pathToFileURL(manifest)).href
}

/** Resolve the running host's SDK copy so Cordis services keep one identity. */
export async function loadHostModule(name: string): Promise<unknown> {
  let hostUrl: URL | undefined
  if (process.argv[1] !== undefined) {
    try {
      hostUrl = pathToFileURL(realpathSync(process.argv[1]))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
  let resolved: string | undefined
  if (hostUrl !== undefined) {
    try {
      resolved = pathToFileURL(createRequire(hostUrl).resolve(name)).href
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && code !== 'MODULE_NOT_FOUND') throw error
      resolved = hostImportUrl(name, hostUrl)
    }
  }
  // Keep execution outside resolution catches: missing transitive dependencies and
  // other module initialization errors must never silently select another SDK.
  return await import(resolved ?? name)
}
