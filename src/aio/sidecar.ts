#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFileSync, chmodSync} from 'node:fs';
import {equal} from '../server/access.js';
import {required} from '../server/settings.js';

const host = JSON.parse(readFileSync(required('AIO_PLUGIN_CONFIG'), 'utf8'));
const upstream = new URL(required('TUNNEL_URL'));
const token = required('TUNNEL_API_TOKEN');
const tenant = required('TUNNEL_AIO_TENANT');
const users = required('TUNNEL_AIO_USERS').split(',');
if (host.tenant_id !== tenant || !host.ingress_token) { throw new Error('AIO tenant configuration rejected'); }
const socket = required('AIO_PLUGIN_SOCKET');

const server = createServer(async (request, response) => {
  const send = (status: number, value: unknown) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value)); };
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'GET' && path === '/health') { send(200, {status: 'ok'}); return; }
  if (request.method === 'GET' && path === '/aio/describe') {
    send(200, {label: 'Tunnel', pages: [{id: 'tunnel', label: 'Tunnel', entry: 'index.html', scene: ['workspace', '工作空间'], menu_path: [], permission: null, surface: 'workspace'}]}); return;
  }
  if (!equal(String(request.headers['x-aio-token'] ?? ''), host.ingress_token) || request.headers['x-aio-tenant-id'] !== tenant || !users.includes(String(request.headers['x-aio-user-id'] ?? ''))) {
    send(403, {error: 'AIO identity rejected'}); return;
  }
  if (!/^\/api\/(services(?:\/[a-z0-9-]+)?|apply)$/.test(path)) { send(404, {error: 'Not found'}); return; }
  try {
    let body = '';
    for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 32_768) { throw new Error('Request too large'); } }
    const result = await fetch(new URL(path, upstream), {method: request.method, headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(30_000)});
    response.writeHead(result.status, {'content-type': 'application/json'}); response.end(await result.text());
  } catch (error) { send(502, {error: error instanceof Error ? error.message : 'Sidecar request failed'}); }
});
server.listen(socket, () => chmodSync(socket, 0o600));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
