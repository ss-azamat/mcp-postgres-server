import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

const DEFAULT_READ_SCOPE = 'postgres:read';
const DEFAULT_WRITE_SCOPE = 'postgres:write';

export interface HttpConfig {
  host: string;
  port: number;
  publicUrl: URL;
  mcpPath: string;
  oauthAudience: string;
  issuer: URL;
  jwksUrl: URL;
  allowedSubjects: ReadonlySet<string>;
  readScope: string;
  writeScope: string;
  resourceMetadataUrl: string;
  rateLimitMax: number;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the HTTP server`);
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function secureUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for localhost development)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query string, or a fragment`);
  }
  return url;
}

function normalizeIssuer(url: URL): URL {
  const normalized = new URL(url.href);
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/';
  return normalized;
}

export function loadHttpConfig(env: Record<string, string | undefined>): HttpConfig {
  const publicUrl = secureUrl(required(env, 'MCP_PUBLIC_URL'), 'MCP_PUBLIC_URL');
  if (publicUrl.pathname === '/') {
    throw new Error('MCP_PUBLIC_URL must include a non-root path such as /mcp or /mcp/postgre/');
  }
  if (/[()*+?[\]{}:]/.test(publicUrl.pathname)) {
    throw new Error('MCP_PUBLIC_URL path must not contain Express route pattern characters');
  }
  const issuer = normalizeIssuer(secureUrl(required(env, 'MCP_OAUTH_ISSUER'), 'MCP_OAUTH_ISSUER'));
  const allowedSubjects = new Set(
    required(env, 'MCP_OAUTH_ALLOWED_SUBJECTS')
      .split(',')
      .map((subject) => subject.trim())
      .filter(Boolean)
  );
  if (allowedSubjects.size === 0) throw new Error('MCP_OAUTH_ALLOWED_SUBJECTS must contain at least one subject');

  const readScope = env.MCP_OAUTH_READ_SCOPE?.trim() || DEFAULT_READ_SCOPE;
  const writeScope = env.MCP_OAUTH_WRITE_SCOPE?.trim() || DEFAULT_WRITE_SCOPE;
  if (readScope === writeScope) throw new Error('MCP_OAUTH_READ_SCOPE and MCP_OAUTH_WRITE_SCOPE must differ');
  const oauthAudience = env.MCP_OAUTH_AUDIENCE?.trim() || publicUrl.href;

  return {
    host: env.MCP_HTTP_HOST?.trim() || '0.0.0.0',
    port: parsePositiveInt(env.PORT, 3000, 'PORT'),
    publicUrl,
    mcpPath: publicUrl.pathname,
    oauthAudience,
    issuer,
    jwksUrl: new URL('.well-known/jwks.json', issuer),
    allowedSubjects,
    readScope,
    writeScope,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicUrl),
    rateLimitMax: parsePositiveInt(env.MCP_RATE_LIMIT_MAX, 60, 'MCP_RATE_LIMIT_MAX'),
  };
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function createAuth0TokenVerifier(
  config: HttpConfig,
  key: JWTVerifyGetKey = createRemoteJWKSet(config.jwksUrl)
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: config.issuer.href,
          audience: config.oauthAudience,
          algorithms: ['RS256'],
        });
        const subject = stringClaim(payload.sub);
        if (subject === undefined) throw new InvalidTokenError('Token has no subject');
        if (!config.allowedSubjects.has(subject)) throw new InvalidTokenError('Token subject is not authorized');
        if (typeof payload.exp !== 'number') throw new InvalidTokenError('Token has no expiration time');
        const scopes = stringClaim(payload.scope)?.split(/\s+/).filter(Boolean) ?? [];
        const clientId = stringClaim(payload.azp) ?? stringClaim(payload.client_id) ?? subject;
        return {
          token,
          clientId,
          scopes,
          expiresAt: payload.exp,
          resource: new URL(config.publicUrl),
          extra: { sub: subject },
        };
      } catch (error) {
        if (error instanceof InvalidTokenError) throw error;
        throw new InvalidTokenError('Access token is invalid or expired');
      }
    },
  };
}

export function protectedResourceMetadata(config: HttpConfig): Record<string, unknown> {
  return {
    resource: config.publicUrl.href,
    authorization_servers: [config.issuer.href],
    scopes_supported: [config.readScope, config.writeScope],
    resource_name: 'PostgreSQL MCP Server',
  };
}
