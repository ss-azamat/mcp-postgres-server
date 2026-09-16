#!/usr/bin/env node
// Builds the MCPB bundle distributed through Smithery and installable in Claude Desktop.
// The bundle ships its own node_modules, so dependencies are installed into a staging
// directory rather than reused from the repo, where devDependencies are present.
//
//   npm run build:mcpb             -> dist/mcp-postgres-server-<version>.mcpb
//   npm run build:mcpb -- --smithery -> dist/mcp-postgres-server-<version>-smithery.mcpb
//
// Two variants exist because the two consumers disagree. The MCPB schema allows only
// {name, description} per tool, while Smithery reads manifest.tools as an MCP ServerCard
// and rejects a tool without an inputSchema. The default bundle stays schema-valid; the
// --smithery variant carries full tool definitions and is what the Smithery listing shows.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const forSmithery = process.argv.includes('--smithery');
const stage = join(repo, 'dist', 'mcpb-stage');
const out = join(repo, 'dist');

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(repo, 'mcpb', 'manifest.json'), 'utf8'));

// package.json is the single source of truth for identity; the manifest only carries
// what has no npm equivalent (user_config, entry point, tool list).
manifest.name = pkg.name;
manifest.version = pkg.version;
manifest.description = pkg.description;

// Asks the built server for its own tool definitions rather than restating them here, so
// the listing cannot drift from the code. No database is needed: the connector throws only
// on first use, so a bare start still answers tools/list.
async function readToolDefinitions() {
  const child = spawn('node', [join(repo, 'build', 'index.js')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n');
    });

  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'build-mcpb', version: pkg.version },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await send('tools/list', {});
  child.kill();

  const tools = listed.result?.tools ?? [];
  if (tools.length === 0) throw new Error('the server listed no tools');
  // Only the fields Smithery's ServerCard schema names; anything else is dropped rather
  // than sent and rejected.
  return tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    inputSchema,
    ...(annotations !== undefined ? { annotations } : {}),
  }));
}

const smitheryTools = forSmithery ? await readToolDefinitions() : undefined;

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });

cpSync(join(repo, 'build'), join(stage, 'server'), { recursive: true });
cpSync(join(repo, 'assets', 'logo.png'), join(stage, 'icon.png'));
cpSync(join(repo, 'mcpb', '.mcpbignore'), join(stage, '.mcpbignore'));
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ssh2 is an optionalDependency but is the point of the SSH tunnel feature, so the bundle
// carries it. Its own native optionalDependency (cpu-features) is skipped, which keeps the
// bundle portable across platforms; ssh2 falls back to its pure-JS paths.
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: `${pkg.name}-bundle`,
      version: pkg.version,
      private: true,
      type: 'module',
      dependencies: { ...pkg.dependencies, ...pkg.optionalDependencies },
    },
    null,
    2,
  ) + '\n',
);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
run('npx', ['-y', '@anthropic-ai/mcpb@2', 'validate', 'manifest.json'], stage);

const name = `${pkg.name}-${pkg.version}${forSmithery ? '-smithery' : ''}.mcpb`;
run('npx', ['-y', '@anthropic-ai/mcpb@2', 'pack', '.', join(out, name)], stage);

// mcpb pack validates too, so the Smithery variant is made by swapping manifest.json inside
// the packed archive, which is a plain zip.
if (forSmithery) {
  manifest.tools = smitheryTools;
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  run('zip', ['-q', join(out, name), 'manifest.json'], stage);
}

rmSync(stage, { recursive: true, force: true });
