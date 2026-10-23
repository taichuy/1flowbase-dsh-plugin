import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { flowbaseApi } from './api.js'
import type { McpReference } from '../shared/api.js'

const SOURCE = '1flowbase MCP'
const referenceId = (mcp: McpReference): string => JSON.stringify([mcp.instanceId, mcp.mcpInstanceId, mcp.serverName])

/** Native @ candidates; re-resolve on send so disabled/deleted connectors cannot become stale references. */
export function mcpReferenceSource(): InputTriggerSource {
  return {
    trigger: '@',
    name: SOURCE,
    async candidates(_session, { query, quoted, signal }) {
      if (quoted === true) return []
      const mcps = await flowbaseApi.mcpReferences(signal)
      const search = query.toLocaleLowerCase()
      return mcps.filter(mcp => [mcp.name, mcp.instanceName, mcp.serverName]
        .some(value => value.toLocaleLowerCase().includes(search)))
        .map(mcp => ({
          name: mcp.serverName,
          label: `${mcp.name} · ${mcp.instanceName}`,
          description: `MCP · ${mcp.serverName}`,
          value: referenceId(mcp),
        }))
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      return { insert: {
        source: SOURCE,
        ref: candidate.value,
        label: candidate.label ?? candidate.name,
        clipboardText: `@${candidate.name}`,
      } }
    },
    codec: {
      clipboardText(ref) {
        // The stable pair remains readable after a persisted draft is restored.
        const [, , serverName] = JSON.parse(ref) as [string, string, string]
        return `@${serverName}`
      },
      async serialize(ref, signal) {
        const mcps = await flowbaseApi.mcpReferences(signal)
        const [instanceId, mcpInstanceId] = JSON.parse(ref) as [string, string, string]
        const mcp = mcps.find(entry => entry.instanceId === instanceId && entry.mcpInstanceId === mcpInstanceId)
        if (mcp === undefined) {
          throw new Error(navigator.language.toLowerCase().startsWith('zh')
            ? '引用的 MCP 实例已停用或未连接，请重新启用或移除引用。'
            : 'The referenced MCP instance is disabled or not connected. Enable it again or remove the reference.')
        }
        return `[Use MCP ${JSON.stringify(mcp.name)} from 1flowbase ${JSON.stringify(mcp.instanceName)}; server namespace: ${mcp.serverName}; tools: mcp__${mcp.serverName}__*]`
      },
    },
  }
}
