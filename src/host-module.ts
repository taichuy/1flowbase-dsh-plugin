import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Resolve the running host's SDK copy so Cordis services keep one identity. */
export async function loadHostModule(name: string): Promise<unknown> {
  const entry = process.argv[1]
  if (entry !== undefined) {
    try {
      const path = createRequire(realpathSync(entry)).resolve(name)
      return await import(pathToFileURL(path).href)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)
        || !['MODULE_NOT_FOUND', 'ENOENT'].includes(String(error.code))) throw error
    }
  }
  return await import(name)
}
