import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAuth0TokenVerifier, loadHttpConfig } from '../src/http-auth.js';

const BASE_ENV = {
  MCP_PUBLIC_URL: 'https://postgres.example.com/mcp',
  MCP_OAUTH_ISSUER: 'https://tenant.us.auth0.com/',
  MCP_OAUTH_ALLOWED_SUBJECTS: 'auth0|allowed, github|also-allowed',
};

describe('loadHttpConfig', () => {
  it('applies hosted-server defaults and derives Auth0 JWKS and metadata URLs', () => {
    const config = loadHttpConfig(BASE_ENV);
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3000);
    expect(config.readScope).toBe('postgres:read');
    expect(config.writeScope).toBe('postgres:write');
    expect(config.oauthAudience).toBe(BASE_ENV.MCP_PUBLIC_URL);
    expect(config.rateLimitMax).toBe(60);
    expect(config.jwksUrl.href).toBe('https://tenant.us.auth0.com/.well-known/jwks.json');
    expect(config.resourceMetadataUrl).toBe('https://postgres.example.com/.well-known/oauth-protected-resource/mcp');
    expect([...config.allowedSubjects]).toEqual(['auth0|allowed', 'github|also-allowed']);
  });

  it('accepts localhost HTTP for development and configurable operational values', () => {
    const config = loadHttpConfig({
      MCP_PUBLIC_URL: 'http://localhost:8787/mcp/postgre/',
      MCP_OAUTH_ISSUER: 'http://localhost:9000/tenant',
      MCP_OAUTH_ALLOWED_SUBJECTS: 'local-user',
      MCP_HTTP_HOST: '127.0.0.1',
      PORT: '8787',
      MCP_OAUTH_READ_SCOPE: 'db:read',
      MCP_OAUTH_WRITE_SCOPE: 'db:write',
      MCP_OAUTH_AUDIENCE: 'https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_test',
      MCP_RATE_LIMIT_MAX: '12',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      mcpPath: '/mcp/postgre/',
      oauthAudience: 'https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_test',
      readScope: 'db:read',
      writeScope: 'db:write',
      rateLimitMax: 12,
    });
    expect(config.issuer.href).toBe('http://localhost:9000/tenant/');
    expect(config.resourceMetadataUrl).toBe('http://localhost:8787/.well-known/oauth-protected-resource/mcp/postgre/');
  });

  it('accepts every loopback hostname and ignores blank subject-list entries', () => {
    expect(loadHttpConfig({ ...BASE_ENV, MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp', MCP_OAUTH_ALLOWED_SUBJECTS: ', auth0|allowed, ,' }).publicUrl.hostname).toBe('127.0.0.1');
    expect(loadHttpConfig({ ...BASE_ENV, MCP_PUBLIC_URL: 'http://[::1]:3000/mcp' }).publicUrl.hostname).toBe('[::1]');
  });

  it.each([
    [{ ...BASE_ENV, MCP_PUBLIC_URL: '' }, /MCP_PUBLIC_URL is required/],
    [{ ...BASE_ENV, MCP_PUBLIC_URL: 'http://postgres.example.com/mcp' }, /must use HTTPS/],
    [{ ...BASE_ENV, MCP_PUBLIC_URL: 'https://postgres.example.com/' }, /non-root path/],
    [{ ...BASE_ENV, MCP_PUBLIC_URL: 'https://postgres.example.com/mcp/:tenant' }, /route pattern characters/],
    [{ ...BASE_ENV, MCP_OAUTH_ISSUER: 'not a url' }, /absolute URL/],
    [{ ...BASE_ENV, MCP_PUBLIC_URL: 'https://user@example.com/mcp' }, /must not contain credentials/],
    [{ ...BASE_ENV, MCP_PUBLIC_URL: 'https://example.com/mcp?x=1' }, /must not contain credentials/],
    [{ ...BASE_ENV, MCP_PUBLIC_URL: 'https://example.com/mcp#x' }, /must not contain credentials/],
    [{ ...BASE_ENV, MCP_OAUTH_ALLOWED_SUBJECTS: '  ' }, /is required/],
    [{ ...BASE_ENV, MCP_OAUTH_ALLOWED_SUBJECTS: ', ,' }, /at least one subject/],
    [{ ...BASE_ENV, PORT: '0' }, /PORT must be a positive integer/],
    [{ ...BASE_ENV, PORT: '3x' }, /PORT must be a positive integer/],
    [{ ...BASE_ENV, PORT: '99999999999999999999999999' }, /PORT must be a positive integer/],
    [{ ...BASE_ENV, MCP_OAUTH_WRITE_SCOPE: 'postgres:read' }, /must differ/],
  ])('fails closed for invalid HTTP/OAuth configuration', (env, message) => {
    expect(() => loadHttpConfig(env)).toThrow(message);
  });
});

describe('createAuth0TokenVerifier', () => {
  async function fixture() {
    const config = loadHttpConfig(BASE_ENV);
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    const verifier = createAuth0TokenVerifier(config, createLocalJWKSet({ keys: [jwk] }));
    const token = async (overrides: {
      subject?: string | null;
      audience?: string;
      issuer?: string;
      expiresIn?: string | null;
      scope?: string | null;
      clientClaim?: 'azp' | 'client_id' | 'none';
    } = {}) => {
      const claims: Record<string, unknown> = {};
      if (overrides.scope !== null) claims.scope = overrides.scope ?? 'postgres:read postgres:write';
      if (overrides.clientClaim !== 'none') claims[overrides.clientClaim ?? 'azp'] = 'codex-client';
      let jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(overrides.issuer ?? config.issuer.href)
        .setAudience(overrides.audience ?? config.publicUrl.href)
        .setIssuedAt();
      if (overrides.subject !== null) jwt = jwt.setSubject(overrides.subject ?? 'auth0|allowed');
      if (overrides.expiresIn !== null) jwt = jwt.setExpirationTime(overrides.expiresIn ?? '5m');
      return jwt.sign(privateKey);
    };
    return { config, verifier, token };
  }

  it('verifies signature, issuer, audience, expiry, scopes, client and allowlisted subject', async () => {
    const { verifier, token, config } = await fixture();
    const auth = await verifier.verifyAccessToken(await token());
    expect(auth).toMatchObject({
      clientId: 'codex-client',
      scopes: ['postgres:read', 'postgres:write'],
      resource: config.publicUrl,
      extra: { sub: 'auth0|allowed' },
    });
    expect(auth.expiresAt).toEqual(expect.any(Number));
  });

  it('verifies a tunnel audience independently of the public resource URL', async () => {
    const config = loadHttpConfig({
      ...BASE_ENV,
      MCP_OAUTH_AUDIENCE: 'https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_test',
    });
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'tunnel-key';
    const verifier = createAuth0TokenVerifier(config, createLocalJWKSet({ keys: [jwk] }));
    const token = await new SignJWT({ scope: 'postgres:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'tunnel-key' })
      .setIssuer(config.issuer.href)
      .setAudience(config.oauthAudience)
      .setSubject('auth0|allowed')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      resource: config.publicUrl,
      scopes: ['postgres:read'],
    });
  });

  it.each([
    [{ subject: 'auth0|stranger' }, /not authorized/],
    [{ audience: 'https://other.example.com/mcp' }, /invalid or expired/],
    [{ issuer: 'https://other.auth0.com/' }, /invalid or expired/],
    [{ expiresIn: '-1s' }, /invalid or expired/],
  ])('rejects an unauthorized or invalid token', async (overrides, message) => {
    const { verifier, token } = await fixture();
    await expect(verifier.verifyAccessToken(await token(overrides))).rejects.toThrow(message);
  });

  it('rejects tokens without a subject or expiry using stable authentication errors', async () => {
    const { verifier, token } = await fixture();
    await expect(verifier.verifyAccessToken(await token({ subject: null }))).rejects.toThrow(/no subject/);
    await expect(verifier.verifyAccessToken(await token({ expiresIn: null }))).rejects.toThrow(/no expiration/);
  });

  it('supports client_id and subject fallbacks and an empty standard scope claim', async () => {
    const { verifier, token } = await fixture();
    const byClientId = await verifier.verifyAccessToken(await token({ clientClaim: 'client_id', scope: ' postgres:read ' }));
    expect(byClientId.clientId).toBe('codex-client');
    expect(byClientId.scopes).toEqual(['postgres:read']);
    const bySubject = await verifier.verifyAccessToken(await token({ clientClaim: 'none', scope: null }));
    expect(bySubject.clientId).toBe('auth0|allowed');
    expect(bySubject.scopes).toEqual([]);
  });

  it('constructs the production remote-JWKS verifier lazily', () => {
    const config = loadHttpConfig(BASE_ENV);
    expect(createAuth0TokenVerifier(config).verifyAccessToken).toEqual(expect.any(Function));
  });
});
