import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Integration fixtures use pinned published SDKs, also available on CI. */
const hostRequire = createRequire(new URL('../../package.json', import.meta.url))

// Resolve every fixture SDK through one dependency graph to preserve Cordis identity.
export async function hostModule(name: string): Promise<any> {
  return await import(pathToFileURL(hostRequire.resolve(name)).href)
}
