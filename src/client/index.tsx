import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { mcpReferenceSource } from './mcp-references.js'
import { FlowbasePanel, installStyles } from './panel.js'

export const inject = ['slots', 'inputTriggers']

function label(): string {
  return navigator.language.toLowerCase().startsWith('zh') ? '1flowbase' : '1flowbase'
}

/** Register the 1flowbase instance table under Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.inputTriggers.registerSource(mcpReferenceSource()), '1flowbase: MCP references')
  ctx.effect(installStyles, '1flowbase-dsh-plugin: styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: '1flowbase',
    order: 80,
    label,
  }, FlowbasePanel))
}
