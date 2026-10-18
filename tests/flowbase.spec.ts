import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { FlowbaseClient, loginAndCreateToken, normalizeBaseUrl } from '../src/flowbase.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function fixture(): Promise<{ baseUrl: string; seen: Record<string, unknown>[] }> {
  const seen: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req)
      seen.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie,
        csrf: req.headers['x-csrf-token'],
        authorization: req.headers.authorization,
        body: body.length === 0 ? undefined : JSON.parse(body) as unknown,
      })
      if (req.url === '/api/public/auth/sign-in' && req.method === 'POST') {
        res.setHeader('set-cookie', 'sid=abc123; Path=/; HttpOnly')
        json(res, 200, { data: { csrf_token: 'csrf-1', effective_display_role: 'root', current_workspace_id: 'ws-1' } })
        return
      }
      if (req.url === '/api/console/user-api-keys/role-options') {
        json(res, 200, { data: { items: [{ code: 'root', name: 'Root', scope_kind: 'system' }] } })
        return
      }
      if (req.url === '/api/console/user-api-keys' && req.method === 'POST') {
        json(res, 200, { data: { token: 'user-token-from-login', role_code: 'root' } })
        return
      }
      if (req.url === '/api/console/applications') {
        json(res, 200, {
          data: [
            { id: 'app-1', application_type: 'agent_flow', name: 'Support flow', description: 'Answers tickets' },
            { id: 'wf-1', application_type: 'workflow', name: 'Nightly', description: 'Not a model' },
          ],
        })
        return
      }
      if (req.url === '/api/console/mcp/catalog') {
        json(res, 200, {
          data: {
            instances: [
              { id: 'record-1', instance_id: 'support', name: 'Support MCP', description_short: 'Ops tools', status: 'enabled' },
            ],
          },
        })
        return
      }
      if (req.url === '/api/console/applications/app-1/api-keys' && req.method === 'POST') {
        json(res, 201, { data: { token: 'app-token' } })
        return
      }
      if (req.url === '/v1/models') {
        json(res, 200, {
          object: 'list',
          data: [{ id: 'inner-model', name: 'Inner', context_window: 64000, max_output_tokens: 8000 }],
        })
        return
      }
      json(res, 404, { error: { code: 'not_found', message: 'missing' } })
    })()
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, seen }
}

describe('FlowbaseClient', () => {
  it('normalizes origins and rejects unsafe URLs', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:7800/')).toBe('http://127.0.0.1:7800')
    expect(normalizeBaseUrl('https://example.com/base/')).toBe('https://example.com/base')
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrowError(/http/u)
    expect(() => normalizeBaseUrl('https://example.com?x=1')).toThrowError(/查询参数/u)
  })

  it('lists only agent-flow applications and reads MCP instances', async () => {
    const { baseUrl, seen } = await fixture()
    const client = new FlowbaseClient({ baseUrl, token: 'user-token' })
    const applications = await client.listApplications()
    expect(applications.map(application => application.id)).toEqual(['app-1'])
    const mcps = await client.listMcpInstances()
    expect(mcps[0]?.instance_id).toBe('support')
    expect(seen[0]?.authorization).toBe('Bearer user-token')
    const result = await client.test()
    expect(result).toEqual({ applicationCount: 1, mcpInstanceCount: 1 })
  })

  it('creates an application key and reads that application model catalog', async () => {
    const { baseUrl, seen } = await fixture()
    const client = new FlowbaseClient({ baseUrl, token: 'user-token' })
    const key = await client.createApplicationKey('app-1', 'DSH dev')
    expect(key).toBe('app-token')
    const models = await client.listApplicationModels(key)
    expect(models[0]?.id).toBe('inner-model')
    expect(seen.find(entry => entry.url === '/v1/models')?.authorization).toBe('Bearer app-token')
  })

  it('signs in and exchanges the cookie session for a durable user API key', async () => {
    const { baseUrl, seen } = await fixture()
    const result = await loginAndCreateToken({
      baseUrl,
      identifier: 'root',
      password: 'change-me',
      expirationPolicy: '30d',
    })
    expect(result).toMatchObject({ token: 'user-token-from-login', workspaceId: 'ws-1', roleCode: 'root' })
    const signIn = seen.find(entry => entry.url === '/api/public/auth/sign-in')
    expect(signIn?.body).toEqual({ identifier: 'root', password: 'change-me' })
    const create = seen.find(entry => entry.url === '/api/console/user-api-keys')
    expect(create?.cookie).toContain('sid=abc123')
    expect(create?.csrf).toBe('csrf-1')
    expect((create?.body as { expiration_policy?: string } | undefined)?.expiration_policy).toBe('30d')
  })

  it('maps HTTP failures to stable codes', async () => {
    const { baseUrl } = await fixture()
    const client = new FlowbaseClient({ baseUrl, token: 'bad' })
    await expect(client.request('/api/console/unknown')).rejects.toMatchObject({ code: 'not-found' })
  })
})
