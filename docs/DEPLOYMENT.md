# Installation, deployment, and operations

This guide covers both supported transports:

- **stdio** for an MCP client that launches the server locally;
- **Streamable HTTP** for a long-lived server behind HTTPS, including Auth0,
  OpenAI Secure MCP Tunnel audience rewriting, nginx, Docker, and small EC2 hosts.

The examples use `https://staging.i-shift.app/mcp/postgre/`. Replace hostnames,
database credentials, Auth0 values, subjects, and tunnel IDs for your environment.

## Requirements

### Local stdio

- Node.js 20 or newer
- Network access to PostgreSQL
- A PostgreSQL role with only the privileges the agent needs

### Hosted HTTP

- Docker 24 or newer
- An HTTPS hostname whose DNS points to the host
- nginx, another TLS reverse proxy, or a managed HTTPS load balancer
- Auth0 or another compatible OAuth 2.1 authorization server
- Network access from the container to PostgreSQL and the authorization server's JWKS

The production MCP endpoint must use HTTPS. The container itself should listen only
on loopback when nginx terminates TLS.

## Prepare an Amazon Linux EC2 host

For Amazon Linux 2023:

```bash
sudo dnf update -y
sudo dnf install -y docker nginx
sudo systemctl enable --now docker
sudo systemctl enable --now nginx
sudo usermod -aG docker ec2-user
```

Log out and back in if you want to run Docker without `sudo`. The commands in this guide
retain `sudo` so they also work before that group change takes effect.

Configure the EC2 security group with:

- TCP 443 from intended MCP clients;
- TCP 80 for certificate issuance and HTTPS redirects;
- TCP 22 only from trusted operator IP addresses;
- no public ingress for TCP 3000.

Create an `A` or `AAAA` DNS record for the HTTPS hostname before requesting the TLS
certificate. Install Certbot using the method supported by the host distribution, then
request a certificate for that hostname, or use an existing managed certificate at the
load balancer.

Recommended host paths:

```text
/etc/mcp-postgres/postgres.env   root-owned runtime secrets and settings
/etc/nginx/conf.d/               nginx virtual host configuration
~/mcp-postgres-server.tar.gz     temporary image transfer; remove after docker load
```

## Install and run with stdio

Run the published package directly:

```bash
npx -y mcp-postgres-server
```

Or install and build a source checkout:

```bash
npm ci
npm run build
node build/index.js
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-postgres-server"],
      "env": {
        "DATABASE_URL": "postgres://mcp_readonly:secret@db.example.com:5432/app",
        "PG_ALLOW_WRITE": "false"
      }
    }
  }
}
```

## Build the HTTP server

### Native source build

```bash
npm ci
npm run build
npm run start:http
```

The HTTP entry point requires the hosted-server variables described below.

### Docker build on the target host

```bash
docker build -t mcp-postgres-server:latest .
```

Building creates temporary layers. On a host with little free disk, build elsewhere
and transfer only the final image.

### Cross-architecture build and transfer

Check the target architecture on EC2:

```bash
uname -m
```

Use `linux/amd64` for `x86_64`, or `linux/arm64` for `aarch64`. From the development
machine, build and export the matching image:

```bash
docker buildx build \
  --platform linux/amd64 \
  --load \
  -t mcp-postgres-server:latest .

docker save mcp-postgres-server:latest | gzip > /tmp/mcp-postgres-server.tar.gz
scp /tmp/mcp-postgres-server.tar.gz ec2-user@YOUR_SERVER_IP:~/
```

Load it on EC2:

```bash
gunzip -c ~/mcp-postgres-server.tar.gz | sudo docker load
rm ~/mcp-postgres-server.tar.gz
```

Building off-host avoids retaining build-stage layers on a small server.

## Configure the hosted server

Create a root-owned environment file:

```bash
sudo install -d -m 700 /etc/mcp-postgres
sudo touch /etc/mcp-postgres/postgres.env
sudo chmod 600 /etc/mcp-postgres/postgres.env
sudoedit /etc/mcp-postgres/postgres.env
```

Example:

```dotenv
DATABASE_URL=postgres://mcp_readonly:CHANGE_ME@database.internal:5432/app
PG_ALLOW_WRITE=false
PG_SSLMODE=verify-full
PG_STATEMENT_TIMEOUT=15000
PG_CONNECT_TIMEOUT=5000
PG_MAX_RESULT_BYTES=16384

MCP_PUBLIC_URL=https://staging.i-shift.app/mcp/postgre/
MCP_OAUTH_ISSUER=https://YOUR_AUTH0_TENANT.auth0.com/
MCP_OAUTH_ALLOWED_SUBJECTS=auth0|YOUR_USER_ID
MCP_OAUTH_READ_SCOPE=postgres:read
MCP_OAUTH_WRITE_SCOPE=postgres:write
MCP_RATE_LIMIT_MAX=20
```

Do not commit this file. `DATABASE_URL`, database passwords, private CA material,
Auth0 credentials, and access tokens are secrets.

### Public endpoint versus token audience

For a direct HTTPS connector, omit `MCP_OAUTH_AUDIENCE`; it defaults to
`MCP_PUBLIC_URL`.

When a connector is reached through OpenAI Secure MCP Tunnel and its OAuth resource
is rewritten, keep `MCP_PUBLIC_URL` unchanged and configure the exact tunnel resource
as the JWT audience:

```dotenv
MCP_PUBLIC_URL=https://staging.i-shift.app/mcp/postgre/
MCP_OAUTH_AUDIENCE=https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_YOUR_TUNNEL_ID
```

The settings have different jobs:

- `MCP_PUBLIC_URL` controls the HTTP route, protected-resource metadata, and public identity.
- `MCP_OAUTH_AUDIENCE` controls only the accepted JWT `aud` claim.

Changing `MCP_PUBLIC_URL` to the tunnel resource would also change the Express route and
break the public nginx path. Use the audience override instead.

### Auth0 configuration

Configure Auth0 so that:

1. The API identifier/audience is the value expected in `MCP_OAUTH_AUDIENCE`, or
   `MCP_PUBLIC_URL` when no override is set.
2. The API exposes `postgres:read` and `postgres:write` permissions.
3. Issued access tokens use RS256 and contain `iss`, `aud`, `sub`, `exp`, and `scope`.
4. The allowed user or client subjects appear exactly in `MCP_OAUTH_ALLOWED_SUBJECTS`.
5. The authorization-code flow uses PKCE and the redirect URI displayed by the
   connector is registered.

The trailing slash is part of a URI. Keep it consistent across the environment,
Auth0, and connector configuration.

## Run on a small EC2 host

The production image is approximately 157 MB and uses roughly 90 MB when idle in a
representative local measurement. Usage varies with traffic and query size. On a 2 GB
host, constrain the process so a bad query restarts only this container instead of
exhausting the machine:

```bash
sudo docker run -d \
  --name mcp-postgres \
  --restart unless-stopped \
  --memory=384m \
  --memory-swap=384m \
  --cpus=0.50 \
  --pids-limit=100 \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --env-file /etc/mcp-postgres/postgres.env \
  -e NODE_OPTIONS=--max-old-space-size=192 \
  -p 127.0.0.1:3000:3000 \
  mcp-postgres-server:latest
```

Notes:

- Binding `127.0.0.1:3000` prevents direct internet access to the Node process.
- The memory limit protects the host, but an oversized result may still cause the
  container to be OOM-killed and restarted.
- `PG_MAX_RESULT_BYTES` limits the returned MCP payload. The PostgreSQL driver may
  buffer rows before that limit is applied, so agents should still use `LIMIT` and
  selective `WHERE` clauses.
- Keep PostgreSQL on a separate host unless the database has its own carefully
  planned memory budget.

Check the container:

```bash
sudo docker ps
sudo docker logs --tail 50 mcp-postgres
curl -i http://127.0.0.1:3000/healthz
```

The health request should return `HTTP/1.1 200 OK` and `{"status":"ok"}`.

## Configure nginx and TLS

The following server block preserves the MCP path and proxies both forms of OAuth
protected-resource metadata. The metadata location must appear before the SPA fallback.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name staging.i-shift.app;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name staging.i-shift.app;

    ssl_certificate /etc/letsencrypt/live/staging.i-shift.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging.i-shift.app/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location ^~ /.well-known/oauth-protected-resource {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ^~ /mcp/postgre/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Keep the application's existing API, asset, and SPA locations below these blocks.
}
```

The `proxy_pass` directives intentionally have no URI suffix. nginx therefore preserves
the complete incoming URI instead of rewriting it.

Validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

No Docker restart is needed after an nginx-only change.

## Verify the public deployment

### Health and OAuth discovery

```bash
curl -i https://staging.i-shift.app/healthz

curl -i \
  https://staging.i-shift.app/.well-known/oauth-protected-resource/mcp/postgre/
```

If `/healthz` is not proxied publicly, test it on EC2 through
`http://127.0.0.1:3000/healthz`. The metadata response must be JSON, not the frontend
application's HTML.

### Authentication challenge

```bash
curl -i \
  -X POST \
  -H 'Content-Type: application/json' \
  https://staging.i-shift.app/mcp/postgre/
```

An unauthenticated request should return `401 Unauthorized` with a header similar to:

```text
WWW-Authenticate: Bearer ... resource_metadata="https://staging.i-shift.app/.well-known/oauth-protected-resource/mcp/postgre/"
```

This is a successful connectivity and authentication-boundary test. Expected `401`
responses are not logged as application errors.

### Authenticated protocol test

Use MCP Inspector or an installed plugin to complete OAuth, initialize the protocol,
list tools, and call a read-only tool. Verify these tools are advertised:

- `query`
- `list_schemas`
- `list_tables`
- `describe_table`
- `execute`

Keep `PG_ALLOW_WRITE=false` until read-only behavior has been verified with the actual
database role.

## Configure the plugin

Update `plugin/mcp.json` in the plugin package; this file is not part of the Docker
runtime and changing it does not require rebuilding or restarting the server. The checked-in
template points at the staging deployment:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "postgres": {
      "type": "streamable-http",
      "url": "https://staging.i-shift.app/mcp/postgre/"
    }
  }
}
```

The server URL remains the public MCP URL even when token verification expects a
tunnel-rewritten audience.

## Apply configuration changes

Docker captures environment values when a container is created. `docker restart` does
not reread `--env-file`. After editing `/etc/mcp-postgres/postgres.env`, recreate the
container using the same image:

```bash
sudo docker rm -f mcp-postgres

sudo docker run -d \
  --name mcp-postgres \
  --restart unless-stopped \
  --memory=384m \
  --memory-swap=384m \
  --cpus=0.50 \
  --pids-limit=100 \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --env-file /etc/mcp-postgres/postgres.env \
  -e NODE_OPTIONS=--max-old-space-size=192 \
  -p 127.0.0.1:3000:3000 \
  mcp-postgres-server:latest
```

Rebuild or load a new image only for source, dependency, package, or Dockerfile changes.
Changes limited to nginx need only an nginx reload. Changes limited to `plugin/mcp.json`
need only a plugin refresh or reinstall.

## Upgrade and rollback

Tag images with a release or commit identifier instead of relying only on `latest`:

```bash
docker buildx build \
  --platform linux/amd64 \
  --load \
  -t mcp-postgres-server:2026-10-06 .
```

After loading the new image on EC2, recreate the container with the new tag. Keep the
previous image until verification succeeds. Roll back by recreating the container with
the previous tag and the unchanged environment file.

Inspect disk use before deleting anything:

```bash
df -h
sudo docker system df
sudo docker image ls
```

Remove only specifically identified, unused image tags. Avoid broad pruning on a host
that runs other containers.

## Monitoring

```bash
sudo docker stats mcp-postgres
sudo docker logs --tail 100 mcp-postgres
sudo docker inspect \
  --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' \
  mcp-postgres
free -h
df -h
```

Exit code `1` normally indicates invalid configuration or another startup failure. Exit
code `137` with `OOMKilled=true` indicates that the memory limit was reached.

## Troubleshooting

### Container repeatedly restarts

```bash
sudo docker logs --tail 100 mcp-postgres
sudo docker inspect \
  --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' \
  mcp-postgres
```

Common causes include a missing required OAuth variable, a public HTTP URL instead of
HTTPS, `PG_ENABLE_RUNTIME_CONNECT=true`, an invalid URL, or an old image that does not
support a newly added setting.

### Local health check cannot connect

Confirm the container is `Up`, not `Restarting`, then read its logs. The published port
appears only while the container process is running.

### Metadata returns the React/Vite HTML page

nginx is sending the well-known URL through the SPA fallback. Add the
`/.well-known/oauth-protected-resource` proxy location shown above, validate nginx, and
reload it.

### Public MCP request returns 401

An unauthenticated `401` with a `WWW-Authenticate` header is expected. If an authenticated
request also returns `401`, check the token's signature, `iss`, `aud`, `exp`, scopes, and
`sub` allowlist. A tunnel deployment commonly needs `MCP_OAUTH_AUDIENCE`.

### Public endpoint returns 502

Confirm that the container is running, that `curl http://127.0.0.1:3000/healthz` succeeds
on EC2, and that nginx targets port 3000 without rewriting the URI.

### Memory pressure

Keep the container memory cap, lower `PG_MAX_RESULT_BYTES`, reduce request rate, shorten
`PG_STATEMENT_TIMEOUT`, and require bounded SQL. The response-size limit does not guarantee
that the PostgreSQL driver never buffers a large result internally.
