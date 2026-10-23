import { describe, expect, it } from 'vitest'
import { FLOWBASE_COMPACTION, installRemoteCompaction, transformPresetConfig } from '../../src/compaction/presets.js'
import { hostModule } from './host.js'

const basic = '@deepseek-ai/dsh-compaction-basic'
const preset = '@deepseek-ai/dsh-agent-preset'
function config() {
  return {
    id: 'fixture', name: 'User preset',
    plugins: [
      { id: 'other', name: 'custom/tool', config: { expression: '!!js untouched' } },
      { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
        { id: 'compaction-basic', name: basic, config: { auto: false, retainTokens: 3000 } },
      ] },
    ],
  }
}

describe('preset-local compaction overlay', () => {
  it('preserves all user settings and raw plugin rows', () => {
    const raw = config()
    const copy = structuredClone(raw)
    const transformed = transformPresetConfig(raw) as ReturnType<typeof config>
    expect(raw).toEqual(copy)
    expect(transformed.plugins[0]).toBe(raw.plugins[0])
    expect(transformed.plugins[1]?.config).toEqual([
      { id: 'compaction-basic', name: FLOWBASE_COMPACTION, config: { auto: false, retainTokens: 3000 } },
    ])
    expect(transformPresetConfig(transformed)).toBe(transformed)
  })

  it('refreshes a real loaded preset and restores its original effective configuration', async () => {
    const { Context } = await hostModule('@deepseek-ai/cordis')
    const { Loader } = await hostModule('@deepseek-ai/cordis-plugin-loader')
    const presetModule = await hostModule(preset)
    const ctx = new Context()
    const registrations: unknown[] = []
    ctx.provide('agentPresets', {
      async register(definition: unknown) {
        registrations.push(definition)
        return async () => {}
      },
    })
    class FixtureLoader extends Loader {
      writes = 0
      write() { this.writes++ }
      async import(name: string) {
        if (name !== preset) throw new Error(`Unexpected fixture import: ${name}`)
        return presetModule
      }
    }
    // Loader's own plugin fiber installs its supported lifecycle and isolation hooks.
    await ctx.plugin(FixtureLoader).await()
    const loader = ctx.loader as InstanceType<typeof FixtureLoader>
    const raw = config()
    await loader.root.update([{ id: 'fixture-preset', name: preset, config: raw }])
    await loader.await()
    const entry = loader.resolve('fixture-preset')
    expect(registrations.at(-1)).toMatchObject(raw)
    const writes = loader.writes
    const overlay = ctx.plugin((child: typeof ctx) => installRemoteCompaction(child, {
      resolveRoute: () => undefined,
      compact: async () => { throw new Error('fixture does not compact') },
    }))
    try {
      await overlay.await()
      await new Promise(resolve => setTimeout(resolve, 10))
      await loader.await()
      expect(entry.options.config).toEqual(raw)
      expect(registrations.at(-1)).toEqual(transformPresetConfig(raw))
      expect(loader.writes).toBe(writes)
      await overlay.dispose()
      await loader.await()
      expect(registrations.at(-1)).toEqual(raw)
      expect(loader.writes).toBe(writes)
    } finally {
      await overlay.dispose()
      await ctx.fiber.dispose()
    }
  })
})
