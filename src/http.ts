#!/usr/bin/env node
import { createServer as createNodeServer, type Server as NodeServer } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  createDatabase,
  createProtocolServer,
  defaultConnector,
  isEntryPoint,
  loadConfig,
  type Connector,
  type Database,
  type ServerConfig,
} from './index.js';
import {
  createAuth0TokenVerifier,
  loadHttpConfig,
  protectedResourceMetadata,
  type HttpConfig,
} from './http-auth.js';

type CloseRequest = () => Promise<void>;

export interface HttpService {
  app: Express;
  httpConfig: HttpConfig;
  serverConfig: ServerConfig;
  close(): Promise<void>;
}

export interface HttpServiceOptions {
  connector?: Connector;
  verifier?: OAuthTokenVerifier;
  database?: Database;
}

function cors(req: Request, res: Response): void {
  const requestedHeaders = req.header('access-control-request-headers');
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': requestedHeaders ?? 'authorization, content-type, mcp-protocol-version',
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
    Vary: 'Access-Control-Request-Headers',
  });
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32603, message }, id: null });
}

async function resolveConnector(config: ServerConfig, override: Connector | undefined): Promise<Connector> {
  if (override !== undefined) return override;
  return config.ssh ? (await import('./ssh-connector.js')).createSshConnector(config.ssh) : defaultConnector;
}

export async function createHttpService(
  env: Record<string, string | undefined>,
  options: HttpServiceOptions = {}
): Promise<HttpService> {
  const serverConfig = loadConfig(env);
  if (serverConfig.allowRuntimeConnect) {
    throw new Error('PG_ENABLE_RUNTIME_CONNECT=true is not supported by the stateless HTTP server');
  }
  const httpConfig = loadHttpConfig(env);
  const connector = await resolveConnector(serverConfig, options.connector);
  const database = options.database ?? createDatabase(serverConfig, connector);
  const verifier = options.verifier ?? createAuth0TokenVerifier(httpConfig);
  const app = createMcpExpressApp({
    host: httpConfig.host,
    allowedHosts: [httpConfig.publicUrl.hostname, 'localhost', '127.0.0.1', '[::1]'],
  });
  const active = new Set<CloseRequest>();
  let closing: Promise<void> | undefined;
  const mcpPath = httpConfig.mcpPath;

  app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

  const metadata = protectedResourceMetadata(httpConfig);
  const metadataPath = new URL(httpConfig.resourceMetadataUrl).pathname;
  app.get(metadataPath, (_req, res) => res.status(200).json(metadata));
  // Some clients probe the origin-wide form before learning the path-specific resource URL.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.status(200).json(metadata));

  app.options(mcpPath, (req, res) => {
    cors(req, res);
    res.sendStatus(204);
  });

  const authenticate = requireBearerAuth({
    verifier,
    requiredScopes: [httpConfig.readScope],
    resourceMetadataUrl: httpConfig.resourceMetadataUrl,
  });
  const limit = rateLimit({
    windowMs: 60_000,
    limit: httpConfig.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.extra?.sub ?? req.auth?.clientId ?? 'authenticated'),
    handler: (_req, res) => jsonRpcError(res, 429, 'Too many MCP requests; retry later'),
  });

  app.post(mcpPath, (req, res, next) => {
    cors(req, res);
    next();
  }, authenticate, limit, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const protocol = createProtocolServer(serverConfig, database, {
      readScope: httpConfig.readScope,
      writeScope: httpConfig.writeScope,
      resourceMetadataUrl: httpConfig.resourceMetadataUrl,
    });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup: CloseRequest = () => (cleanupPromise ??= protocol.close().catch(() => undefined));
    active.add(cleanup);
    res.once('close', () => {
      active.delete(cleanup);
      void cleanup();
    });
    try {
      await protocol.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[postgres-server] HTTP MCP request failed:', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    } finally {
      active.delete(cleanup);
      await cleanup();
    }
  });

  app.all(mcpPath, (_req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    jsonRpcError(res, 405, 'Method not allowed');
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  return {
    app,
    httpConfig,
    serverConfig,
    close: () => (closing ??= (async () => {
      await Promise.all([...active].map((close) => close()));
      active.clear();
      await database.close();
    })()),
  };
}

function listen(server: NodeServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeHttpServer(server: NodeServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const service = await createHttpService(env);
  const server = createNodeServer(service.app);
  await listen(server, service.httpConfig.host, service.httpConfig.port);
  console.error(
    `[postgres-server] Streamable HTTP listening on ${service.httpConfig.host}:${service.httpConfig.port}${service.httpConfig.mcpPath} in ${
      service.serverConfig.readOnly ? 'read-only' : 'READ-WRITE'
    } mode`
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeHttpServer(server)
      .then(() => service.close())
      .catch((error) => console.error('[postgres-server] shutdown failed:', error))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export function bootstrap(entry: string | undefined, moduleUrl: string): void {
  if (!isEntryPoint(entry, moduleUrl)) return;
  main().catch((error) => {
    console.error('[postgres-server] fatal:', error);
    process.exit(1);
  });
}

bootstrap(process.argv[1], import.meta.url);
