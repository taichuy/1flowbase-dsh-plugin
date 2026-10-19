import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { createHttpHandler } from './http.js'
import { McpRegistry } from './mcp.js'
import { ModelRegistry } from './models.js'
import { defaultStateDir, StateStore } from './state.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = '1flowbase'

/** Services required before the settings API and model routes can mount. */
export const inject = ['webServer', 'llm']

const DEFAULT_TIMEOUT_MS = 20_000

/** Host configuration; every field is optional. */
export interface Config {
  /** Durable state directory; defaults to `$DSH_HOME/1flowbase-dsh-plugin`. */
  stateDir?: string
  /** Timeout for one 1flowbase console request. */
  requestTimeoutMs?: number
}

/**
 * Mount the 1flowbase instance manager: durable state, imported agent-flow
 * models on the Harness LLM registry, dynamic MCP connectors, and the
 * same-origin settings API.
 * @param ctx - Host context carrying the web server and LLM registry.
 * @param config - optional state directory and request timeout.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const store = new StateStore(config.stateDir ?? defaultStateDir())
  await store.load()
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const models = new ModelRegistry(ctx, store, timeoutMs)
  const mcps = new McpRegistry(ctx, store, timeoutMs)
  const handler = createHttpHandler({ store, models, mcps, timeoutMs })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/api/1flowbase', handler }),
    '1flowbase: settings API route',
  )

  models.refresh()
  // The selector is usable before any settings page is opened: imported
  // catalogues are reconciled in the background, so a restart alone is enough.
  void models.reconcileAll()
  void mcps.restore()

  ctx.effect(() => {
    return () => {
      models.dispose()
      return mcps.dispose()
    }
  }, '1flowbase: model and MCP lifecycle')

  ctx.logger('1flowbase').info(
    'loaded %d instance(s), %d imported application(s), %d MCP connector(s)',
    store.snapshot().instances.length,
    store.snapshot().instances.reduce((total, instance) => total + instance.applications.length, 0),
    store.snapshot().instances.reduce((total, instance) => total + instance.mcps.length, 0),
  )
}
