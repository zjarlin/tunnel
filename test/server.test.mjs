import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, request} from 'node:http';
import {once} from 'node:events';

async function ready(child) {
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Startup timed out')), 5000); timer.unref(); }),
  ]);
}

test('standalone authentication, internal publishing, restart persistence and blocked public DNS', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-test-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let changes = [];
  const caddy = createServer(async (req, res) => {
    if (req.method === 'POST') { let body = ''; for await (const chunk of req) { body += chunk; } changes.push(JSON.parse(body)); }
    res.setHeader('etag', '"/config/ test"');
    res.end(JSON.stringify({apps: {http: {servers: {test: {routes: [{match: [{host: ['127.0.0.1']}]}]}}}, tls: {automation: {policies: []}}}}));
  });
  caddy.listen(0, '127.0.0.1'); await once(caddy, 'listening');
  const env = {...process.env, TUNNEL_DATA: dir, TUNNEL_DOMAIN: 'example.test', TUNNEL_RAW_HOST: 'raw.example.test', TUNNEL_LAN_IP: '127.0.0.1', TUNNEL_ALLOWED_CIDRS: '127.0.0.1/32', TUNNEL_BIND: '127.0.0.1', TUNNEL_PORT: String(port), TUNNEL_PUBLIC_URL: `http://127.0.0.1:${port}`, TUNNEL_ADMIN_USER: 'tester', TUNNEL_ADMIN_PASSWORD: 'test-only-password', TUNNEL_API_TOKEN: 'test-api-token', TUNNEL_CADDY_ADMIN: `http://127.0.0.1:${caddy.address().port}`, TUNNEL_CF_TOKEN: '', TUNNEL_CF_ZONE: ''};
  let child = spawn(process.execPath, ['dist/server.mjs'], {env, stdio: ['ignore', 'pipe', 'inherit']});
  t.after(async () => { child.kill(); caddy.closeAllConnections(); await new Promise(resolve => caddy.close(resolve)); rmSync(dir, {recursive: true, force: true}); });
  await ready(child);
  const base = env.TUNNEL_PUBLIC_URL;
  const api = (path, method = 'GET', body, headers = {}) => fetch(base + path, {method, headers: {'content-type': 'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined});
  assert.equal((await api('/api/services')).status, 401);
  assert.equal((await api('/api/login', 'POST', {user: 'tester', password: 'wrong'})).status, 400);
  const login = await api('/api/login', 'POST', {user: 'tester', password: 'test-only-password'});
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const auth = {cookie: login.headers.get('set-cookie').split(';')[0]};
  assert.equal((await api('/api/services', 'GET', undefined, auth)).status, 200);
  assert.equal((await api('/api/services', 'PUT', {}, {...auth, origin: 'https://evil.test'})).status, 403);
  const item = {alias: 'git', host: '127.0.0.1', port: 8080, scheme: 'http', visibility: 'internal', note: 'test'};
  assert.equal((await api('/api/services', 'PUT', {...item, alias: '../escape'}, auth)).status, 400);
  assert.equal((await api('/api/services', 'PUT', item, auth)).status, 200);
  assert.equal((await api('/api/apply', 'POST', {}, auth)).status, 200);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].apps.http.servers.test.routes[0].handle[0].routes[0].handle[0].routes[0].match[0].remote_ip.ranges[0], '127.0.0.1/32');
  assert.equal(changes[0].apps.http.servers.test.routes[0].handle[0].routes[0].handle[0].routes[1].handle[0].status_code, 404);
  await api('/api/services', 'PUT', {...item, alias: 'public', visibility: 'public'}, auth);
  assert.equal((await api('/api/apply', 'POST', {}, auth)).status, 400);
  assert.equal(changes.length, 1, 'blocked DNS must not publish Caddy changes');
  child.kill(); await once(child, 'exit');
  child = spawn(process.execPath, ['dist/server.mjs'], {env, stdio: ['ignore', 'pipe', 'inherit']}); await ready(child);
  const restored = await api('/api/services', 'GET', undefined, {authorization: 'Bearer test-api-token'});
  assert.equal((await restored.json()).items.length, 2);
});

test('AIO sidecar rejects wrong tenant and forwards only authorized service requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-sidecar-'));
  const socket = join(dir, 'service.sock');
  const upstream = createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer test-upstream-token'); res.end(JSON.stringify({items: []})); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  writeFileSync(join(dir, 'host.json'), JSON.stringify({tenant_id: 'test-tenant', ingress_token: 'test-ingress-token'}));
  const child = spawn(process.execPath, ['dist/sidecar.mjs'], {env: {...process.env, AIO_PLUGIN_CONFIG: join(dir, 'host.json'), AIO_PLUGIN_SOCKET: socket, TUNNEL_URL: `http://127.0.0.1:${upstream.address().port}`, TUNNEL_API_TOKEN: 'test-upstream-token', TUNNEL_AIO_TENANT: 'test-tenant', TUNNEL_AIO_USERS: 'test-admin'}, stdio: ['ignore', 'pipe', 'inherit']});
  t.after(async () => { child.kill(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); rmSync(dir, {recursive: true, force: true}); });
  const call = (path, headers = {}) => new Promise((resolve, reject) => { const req = request({socketPath: socket, path, headers}, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(body)})); }); req.on('error', reject); req.end(); });
  await ready(child);
  assert.equal((await call('/aio/describe')).body.pages[0].id, 'tunnel');
  assert.equal((await call('/api/services')).status, 403);
  const auth = {'x-aio-token': 'test-ingress-token', 'x-aio-tenant-id': 'test-tenant', 'x-aio-user-id': 'test-admin'};
  assert.equal((await call('/api/services', {...auth, 'x-aio-tenant-id': 'other'})).status, 403);
  assert.equal((await call('/api/services', auth)).status, 200);
  assert.equal((await call('/api/login', auth)).status, 404);
});
