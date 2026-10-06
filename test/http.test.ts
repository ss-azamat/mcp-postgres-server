import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { createHttpService, type HttpService } from '../src/http.js';
import { createProtocolServer, loadConfig, type Database } from '../src/index.js';

const ENV = {
  DATABASE_URL: 'postgres://u:p@db.example.com/app',
  MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
  MCP_OAUTH_ISSUER: 'http://localhost:9000/',
  MCP_OAUTH_ALLOWED_SUBJECTS: 'auth0|owner',
};

function fakeDatabase(): Database {
  return {
    query: vi.fn(async () => ({ ok: true, data: { rows: [{ value: 1 }], rowCount: 1, returnedRows: 1, truncated: false } })),
    execute: vi.fn(async () => ({ ok: true, data: { rowCount: 1, command: 'UPDATE' } })),
    listSchemas: vi.fn(async () => ({ ok: true, data: { schemas: ['public'] } })),
    listTables: vi.fn(async () => ({ ok: true, data: { tables: ['users'] } })),
    describeTable: vi.fn(async () => ({ ok: true, data: { columns: [] } })),
    retarget: vi.fn(async () => ({ ok: true, data: { host: 'h', database: 'd' } })),
    close: vi.fn(async () => undefined),
  };
}

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    if (token !== 'read' && token !== 'write') throw new InvalidTokenError('Bad token');
    return {
      token,
      clientId: 'codex-client',
      scopes: token === 'write' ? ['postgres:read', 'postgres:write'] : ['postgres:read'],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      extra: { sub: 'auth0|owner' },
    };
  },
};

const openServers: Server[] = [];
const openServices: HttpService[] = [];

async function start(overrides: Record<string, string> = {}, database = fakeDatabase()) {
  const service = await createHttpService({ ...ENV, ...overrides }, { database, verifier });
  const server = createServer(service.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  openServices.push(service);
  const port = (server.address() as AddressInfo).port;
  return { service, server, database, base: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
  await Promise.all(openServices.splice(0).map((service) => service.close()));
});

describe('Streamable HTTP service', () => {
  it('serves health and OAuth protected-resource metadata without authentication', async () => {
    const { base, service } = await start();
    await expect(fetch(`${base}/healthz`).then((r) => r.json())).resolves.toEqual({ status: 'ok' });
    const response = await fetch(`${base}${new URL(service.httpConfig.resourceMetadataUrl).pathname}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: ENV.MCP_PUBLIC_URL,
      authorization_servers: [ENV.MCP_OAUTH_ISSUER],
      scopes_supported: ['postgres:read', 'postgres:write'],
    });
  });

  it('challenges missing tokens with OAuth discovery information', async () => {
    const { base, service } = await start();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`resource_metadata="${service.httpConfig.resourceMetadataUrl}"`);
  });

  it('answers CORS preflight and rate-limits authenticated subjects', async () => {
    const { base } = await start({ MCP_RATE_LIMIT_MAX: '1' });
    const preflight = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: { 'access-control-request-headers': 'authorization, content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    const init = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    const first = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: 'Bearer read', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init),
    });
    expect(first.status).toBe(200);
    const limited = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: 'Bearer read', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init),
    });
    expect(limited.status).toBe(429);
  });

  it('initializes through the real SDK client and advertises OAuth scopes on every tool', async () => {
    const { base } = await start();
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer read' } },
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(['describe_table', 'execute', 'list_schemas', 'list_tables', 'query']);
    for (const tool of tools) expect(tool._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: expect.any(Array) }]);
    await client.close();
  });

  it('serves a nested MCP path derived from MCP_PUBLIC_URL', async () => {
    const { base, service } = await start({ MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp/postgre/' });
    expect(service.httpConfig.mcpPath).toBe('/mcp/postgre/');
    const transport = new StreamableHTTPClientTransport(new URL(`${base}${service.httpConfig.mcpPath}`), {
      requestInit: { headers: { Authorization: 'Bearer read' } },
    });
    const client = new Client({ name: 'nested-path-test', version: '1.0.0' });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();

    const oldPath = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(oldPath.status).toBe(404);
  });

  it('calls read tools with a read token and rejects write tools without the write scope', async () => {
    const database = fakeDatabase();
    const { base } = await start({ PG_ALLOW_WRITE: 'true' }, database);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer read' } },
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.callTool({ name: 'list_tables', arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(database.listTables).toHaveBeenCalledWith('public');
    const denied = await client.callTool({ name: 'execute', arguments: { sql: 'UPDATE users SET active = true' } });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.['mcp/www_authenticate']).toBeDefined();
    expect(database.execute).not.toHaveBeenCalled();
    await client.close();
  });

  it('allows execute with both scopes and closes the shared database once', async () => {
    const database = fakeDatabase();
    const { base, service } = await start({ PG_ALLOW_WRITE: 'true' }, database);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer write' } },
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'execute', arguments: { sql: 'UPDATE users SET active = true' } });
    expect(result.isError).not.toBe(true);
    expect(database.execute).toHaveBeenCalledOnce();
    await client.close();
    await service.close();
    await service.close();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it.each(['GET', 'DELETE'])('returns 405 for unsupported %s /mcp', async (method) => {
    const { base } = await start();
    const response = await fetch(`${base}/mcp`, { method, headers: { Authorization: 'Bearer read' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('fails startup when runtime database retargeting is enabled', async () => {
    await expect(createHttpService({ ...ENV, PG_ENABLE_RUNTIME_CONNECT: 'true' }, { database: fakeDatabase(), verifier }))
      .rejects.toThrow(/not supported/);
  });

  it('enforces tool scopes inside the protocol layer as defense in depth', async () => {
    const database = fakeDatabase();
    const server = createProtocolServer(
      loadConfig({ PG_ENABLE_RUNTIME_CONNECT: 'true' }),
      database,
      { readScope: 'postgres:read', writeScope: 'postgres:write', resourceMetadataUrl: 'https://postgres.example.com/.well-known/oauth-protected-resource/mcp' }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'scope-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const read = await client.callTool({ name: 'list_schemas', arguments: {} });
    expect(read.isError).toBe(true);
    expect((read.content[0] as { text: string }).text).toMatch(/requires scope: postgres:read/);
    const connect = await client.callTool({
      name: 'connect_db',
      arguments: { host: 'h', user: 'u', password: 'p', database: 'd' },
    });
    expect(connect.isError).toBe(true);
    expect(database.retarget).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });
});
