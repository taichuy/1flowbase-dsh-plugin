import { describe, expect, it } from 'vitest'
import { mcpServerName } from '../src/mcp.js'

describe('mcpServerName', () => {
  it('combines the display name with the instance id', () => {
    expect(mcpServerName('Support MCP', 'support')).toBe('Support_MCP_support')
    expect(mcpServerName('ops', 'Ops_2026')).toBe('ops_Ops_2026')
  })

  it('keeps only the DSH server-name grammar and caps at 32 characters', () => {
    const value = mcpServerName('客服 MCP / tools', 'instance/with spaces')
    expect(value).toMatch(/^[A-Za-z0-9_-]{1,32}$/u)
    expect(value.length).toBeLessThanOrEqual(32)
    expect(mcpServerName('x'.repeat(60), 'short')).toHaveLength(32)
  })

  it('falls back when every display character is unusable', () => {
    expect(mcpServerName('客服', '实例/abc')).toMatch(/^mcp_/u)
  })
})
