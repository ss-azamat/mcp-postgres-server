# System architecture

## Overview

The project supports two transports over one PostgreSQL/tool implementation:

```text
Local MCP client                          Hosted MCP client / plugin
       |                                            |
       | stdio                                      | HTTPS Streamable HTTP
       v                                            v
 build/index.js                         nginx / HTTPS load balancer
       |                                            |
       |                                  POST /mcp/postgre/
       |                                            v
       |                                  build/http.js (Express)
       |                                            |
       |                                  OAuth + subject + rate limit
       |                                            |
       +---------------------+----------------------+
                             |
                             v
                  MCP protocol and tool registry
                             |
                             v
                  shared database abstraction
                             |
                direct TCP/TLS or SSH tunnel
                             |
                             v
                         PostgreSQL
```

The stdio transport remains suitable for one local MCP client process. The HTTP transport
is a long-lived service intended for a reverse proxy or load balancer.

## Source modules

| Module | Responsibility |
|--------|----------------|
| `src/index.ts` | Configuration, PostgreSQL adapter, result limits, read/write behavior, MCP tools, stdio entry point, and the reusable protocol-server factory |
| `src/http.ts` | Express application, Streamable HTTP transport, CORS, rate limiting, health check, OAuth middleware, request lifecycle, and graceful shutdown |
| `src/http-auth.ts` | Hosted-server configuration, protected-resource metadata, Auth0 JWKS verification, issuer/audience validation, and subject allowlisting |
| `src/ssh-connector.ts` | Optional SSH bastion connection, host-key pinning, forwarding, keepalive, and reconnect behavior |
| `src/errors.ts` | Stable error normalization and hints |

`createProtocolServer` in `src/index.ts` is the main boundary between transport code and
database/tool behavior. Both entry points register the same tools through that factory.

## Hosted request path

For `MCP_PUBLIC_URL=https://staging.i-shift.app/mcp/postgre/`, the path is derived as
`/mcp/postgre/`; it is not hard-coded in the HTTP server.

```text
Client
  |
  | POST https://staging.i-shift.app/mcp/postgre/
  v
nginx
  | preserves URI; terminates TLS
  v
Express on 127.0.0.1:3000
  |
  +-- CORS headers
  +-- Bearer token verification
  +-- global read-scope requirement
  +-- per-subject rate limit
  v
Fresh stateless StreamableHTTPServerTransport
  |
  v
Fresh MCP protocol server
  |
  v
Shared process-owned database service
```

The HTTP deployment is stateless at the MCP transport layer. Each HTTP request receives a
fresh protocol server and transport, while the process owns one reusable database service.
The protocol instance closes at the end of the response; the database closes during process
shutdown.

`GET` and `DELETE` on the MCP route return `405`. The service uses JSON request/response
operation and does not expose a long-lived server-initiated SSE endpoint.

## OAuth architecture

The MCP server is an OAuth resource server; Auth0 is the authorization server.

```text
Client / OpenAI host
  |
  | 1. unauthenticated MCP request
  v
MCP server -- 401 + resource_metadata URL --> Client
  ^                                                |
  |                                                | 2. fetch protected-resource metadata
  |                                                v
  +-------------------------------------- metadata endpoint
                                                   |
                                                   | 3. authorization code + PKCE
                                                   v
                                                Auth0
                                                   |
                                                   | 4. signed access token
                                                   v
Client / OpenAI host -- Authorization: Bearer --> MCP server
```

The server validates:

1. RS256 signature through the issuer's JWKS;
2. exact issuer;
3. exact configured audience;
4. expiration;
5. exact subject membership in `MCP_OAUTH_ALLOWED_SUBJECTS`;
6. global read scope and tool-specific scopes.

Read tools require the configured read scope. `execute` requires both read and write scopes.
When `PG_ALLOW_WRITE=true`, `query` also requires both scopes because that mode sends its SQL
directly and cannot promise read-only behavior.

### Public identity and tunnel audience

Normally the resource identity and token audience are the same:

```text
MCP_PUBLIC_URL      = https://staging.i-shift.app/mcp/postgre/
JWT aud             = https://staging.i-shift.app/mcp/postgre/
```

An OpenAI Secure MCP Tunnel can present a rewritten resource to the OAuth flow. In that case:

```text
MCP_PUBLIC_URL      = https://staging.i-shift.app/mcp/postgre/
MCP_OAUTH_AUDIENCE  = https://tunnel-service.../v1/mcp/tunnel_<id>
JWT aud             = https://tunnel-service.../v1/mcp/tunnel_<id>
```

Separating these values preserves the public route and metadata location while validating
the token actually issued for the tunnel connector.

## OAuth discovery routes

The server publishes the same protected-resource document at:

```text
/.well-known/oauth-protected-resource/mcp/postgre/
/.well-known/oauth-protected-resource
```

The path-specific form is advertised in `WWW-Authenticate`. The origin-wide form supports
clients that probe the base well-known location first. nginx must proxy these routes to the
MCP container instead of passing them to a frontend SPA.

## Database and security boundary

The PostgreSQL role is the primary security boundary. HTTP OAuth controls who can ask the
server to use that role; it does not increase or reduce the role's database privileges.

In the default read-only mode:

```text
BEGIN READ ONLY
<bound SQL statement>
ROLLBACK
```

PostgreSQL therefore refuses writes hidden inside functions, views, or rules. `execute`
refuses writes before sending SQL unless `PG_ALLOW_WRITE=true`. Prepared parameters are
bound through `node-postgres`; values are not interpolated into SQL text.

`connect_db` is intentionally unavailable in hosted stateless HTTP. Starting the HTTP
service with `PG_ENABLE_RUNTIME_CONNECT=true` fails closed because changing one shared
database target cannot be isolated safely per stateless caller.

## Result and resource limits

- `PG_STATEMENT_TIMEOUT` bounds statement execution time.
- `PG_CONNECT_TIMEOUT` bounds a connection attempt.
- `PG_MAX_RESULT_BYTES` bounds the serialized rows returned to the model.
- `MCP_RATE_LIMIT_MAX` bounds requests per authenticated subject per minute in one process.
- Docker memory, CPU, PID, and log limits protect a small host from the service process.

The result-byte budget is applied after the driver receives the query result. It limits
model context and response size, but callers must still use `LIMIT` because a very large
result can consume memory while being received.

## Process lifecycle

### Startup

1. Parse PostgreSQL and HTTP configuration.
2. Refuse unsafe or inconsistent settings.
3. Construct the database service and lazy Auth0 JWKS verifier.
4. Bind the Express application.
5. Report the listen address, MCP route, and read-only/read-write mode on stderr.

The database connection is established lazily on the first database operation.

### Request

1. nginx terminates TLS and preserves the URI.
2. Express adds CORS headers.
3. OAuth middleware validates the bearer token and read scope.
4. Rate limiting keys the request by authenticated subject.
5. The service creates a stateless MCP transport and protocol instance.
6. The selected tool enforces its own scopes again as defense in depth.
7. The database operation executes and returns a bounded tool result.
8. The protocol instance closes after the response.

### Shutdown

`SIGINT` or `SIGTERM` stops the HTTP listener, closes active protocol instances, closes the
database service and optional SSH tunnel, and exits. Docker uses this path during an orderly
container replacement.

## Deployment topology

Recommended EC2 topology:

```text
Internet :443
    |
    v
nginx + Let's Encrypt
    |
    | http://127.0.0.1:3000, original URI preserved
    v
Docker: mcp-postgres
    |
    | outbound PostgreSQL TLS
    +-------------------------------> RDS / managed PostgreSQL
    |
    | outbound HTTPS
    +-------------------------------> Auth0 JWKS
```

Only ports 80 and 443 need public ingress for the web host; restrict SSH to operator IPs.
Do not publish container port 3000 on `0.0.0.0` when nginx is the public entry point.

## Packaging boundaries

The Docker image contains the compiled server and production dependencies. It does not need
the portable plugin files at runtime.

```text
Docker/runtime changes: src/, package.json, package-lock.json, Dockerfile
Plugin/client changes:  plugin/plugin.json, plugin/mcp.json
Proxy changes:          nginx configuration
Runtime settings:       /etc/mcp-postgres/postgres.env
```

Consequently:

- source or dependency changes require a new image and container replacement;
- environment changes require only container replacement with the same image;
- nginx changes require only `nginx -t` and reload;
- plugin URL or metadata changes require a plugin refresh/reinstall, not a Docker rebuild.
