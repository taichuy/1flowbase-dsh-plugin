import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('installable dsh bundle', () => {
  it('declares the bundle patch, browser half and exports', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      dsh?: { bundle?: { patch?: string }; client?: { inject?: string[]; platform?: string } }
      exports?: Record<string, unknown>
      files?: string[]
    }
    expect(manifest.name).toBe('1flowbase-dsh-plugin')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    await expect(access(new URL('../lib/client.js', import.meta.url))).resolves.toBeUndefined()
  })

  it('inserts one Host row and keeps settings ownership on the bare package', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('- id: 1flowbase\n      name: 1flowbase-dsh-plugin')
    expect(patch).toContain('stateDir: !!js process.env.DSH_1FLOWBASE_STATE_DIR')
  })

  it('documents the two authentication modes and both bridges', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    expect(readme).toContain('API Key')
    expect(readme).toContain('登录授权')
    expect(readme).toContain('mcp__<name>_<instance_id>__<tool>')
    expect(readme).toContain('/api/1flowbase')
  })
})
