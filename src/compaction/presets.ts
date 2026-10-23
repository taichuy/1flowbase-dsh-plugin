import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { FlowbaseProtocols } from './service.js'

const PRESET = '@deepseek-ai/dsh-agent-preset'
const BASIC = '@deepseek-ai/dsh-compaction-basic'
export const FLOWBASE_COMPACTION = '1flowbase-dsh-plugin/compaction'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Clone only changed preset plugin lists; leave expressions and unrelated config intact. */
export function transformPresetConfig(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.plugins)) return value
  const plugins = transformRows(value.plugins)
  return plugins === value.plugins ? value : { ...value, plugins }
}

function transformRows(rows: unknown[]): unknown[] {
  let changed = false
  const result = rows.map(row => {
    if (!record(row)) return row
    let next = row
    if (row.name === BASIC) next = { ...next, name: FLOWBASE_COMPACTION }
    if (row.group === true && Array.isArray(row.config)) {
      const config = transformRows(row.config)
      if (config !== row.config) next = { ...next, config }
    }
    if (next !== row) changed = true
    return next
  })
  return changed ? result : rows
}

type PresetFiber = Fiber & { entry?: { options: { name?: string; config?: unknown } } }

/** Install an effective-config overlay without editing profile or user preset data. */
export function installRemoteCompaction(ctx: Context, callbacks: FlowbaseProtocols): void {
  ctx.provide('flowbaseProtocols', callbacks)
  let active = true
  const transformed = new Set<PresetFiber>()
  const removeHook = ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const effective: unknown = next()
    const fiber = this as PresetFiber
    if (!active || fiber.entry?.options.name !== PRESET) return effective
    const result = transformPresetConfig(effective)
    if (result !== effective) transformed.add(fiber)
    return result
  }, { global: true })

  async function refresh(fiber: PresetFiber): Promise<void> {
    await fiber.await()
    if (!active || fiber.uid === null || fiber.entry?.options.name !== PRESET) return
    // Re-resolve the original loader-owned config; noSave excludes persistence hooks.
    fiber.update(fiber.entry.options.config, true)
    await fiber.await()
  }

  const timer = setTimeout(() => {
    const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
      .filter(fiber => (fiber as PresetFiber).entry?.options.name === PRESET)
    void Promise.all(fibers.map(fiber => refresh(fiber as PresetFiber))).catch(error => {
      ctx.logger.error('Unable to refresh preset compaction configuration', error)
    })
  }, 0)

  ctx.effect(() => async () => {
    active = false
    clearTimeout(timer)
    removeHook()
    for (const fiber of transformed) {
      await fiber.await()
      if (fiber.uid === null || fiber.entry?.options.name !== PRESET) continue
      // Read the latest original config, including edits made while the overlay was active.
      fiber.update(fiber.entry.options.config, true)
      await fiber.await()
    }
    transformed.clear()
  })
}
