import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';

async function ready(child) {
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Startup timed out')), 5000); timer.unref(); }),
  ]);
}

/**
 * 上游探测只报问题、不拦发布：一台后端离线时其余路由必须照常下发，
 * 并把不可达条目写进发布记录，避免「一台机器关机导致整站发布失败」。
 */
test('上游暂不可达不阻断发布，只在发布记录里点名', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-warn-'));
  const live = createServer((_req, res) => res.end('ok')); live.listen(0, '127.0.0.1'); await once(live, 'listening');
  const livePort = live.address().port;
  const dead = createServer(); dead.listen(0, '127.0.0.1'); await once(dead, 'listening');
  const deadPort = dead.address().port; await new Promise(resolve => dead.close(resolve));
  // 控制台自己占一个临时端口，不能复用被测服务端口。
  const spare = createServer(); spare.listen(0, '127.0.0.1'); await once(spare, 'listening');
  const port = spare.address().port; await new Promise(resolve => spare.close(resolve));
  const published = [];
  const caddy = createServer(async (req, res) => {
    if (req.method === 'POST') { let body = ''; for await (const chunk of req) { body += chunk; } published.push(JSON.parse(body)); }
    res.setHeader('etag', '"/config/ test"');
    res.end(JSON.stringify({apps: {http: {servers: {test: {routes: [{match: [{host: ['127.0.0.1']}]}]}}}}}));
  });
  caddy.listen(0, '127.0.0.1'); await once(caddy, 'listening');

  const registryFile = join(dir, 'aliases.json');
  writeFileSync(registryFile, JSON.stringify({aliases: [
    {alias: 'live', host: '127.0.0.1', port: livePort, scheme: 'http', visibility: 'internal', note: '在线'},
    {alias: 'dead', host: '127.0.0.1', port: deadPort, scheme: 'http', visibility: 'internal', note: '离线'},
  ]}));

  const env = {...process.env, TUNNEL_DATA: dir, TUNNEL_REGISTRY_FILE: registryFile, TUNNEL_DOMAIN: 'example.test', TUNNEL_RAW_HOST: 'raw.example.test', TUNNEL_LAN_IP: '127.0.0.1', TUNNEL_ALLOWED_CIDRS: '127.0.0.1/32', TUNNEL_BIND: '127.0.0.1', TUNNEL_PORT: String(port), TUNNEL_PUBLIC_URL: `http://127.0.0.1:${port}`, TUNNEL_ADMIN_USER: 'tester', TUNNEL_ADMIN_PASSWORD: 'test-only-password', TUNNEL_API_TOKEN: 'test-api-token', TUNNEL_CADDY_ADMIN: `http://127.0.0.1:${caddy.address().port}`, TUNNEL_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), TUNNEL_TCP_CATALOG: join(dir, 'tcp.json'), TUNNEL_VERIFY_UPSTREAM: '1', TUNNEL_ACME_DIRECTORY: '', TUNNEL_CF_TOKEN: '', TUNNEL_CF_ZONE: ''};
  writeFileSync(env.TUNNEL_TCP_CATALOG, JSON.stringify({version: 1, items: []}));
  const child = spawn(process.execPath, ['dist/server.mjs'], {env, stdio: ['ignore', 'pipe', 'inherit']});
  t.after(async () => { child.kill(); caddy.closeAllConnections(); await new Promise(resolve => caddy.close(resolve)); live.closeAllConnections(); await new Promise(resolve => live.close(resolve)); rmSync(dir, {recursive: true, force: true}); });
  await ready(child);

  const api = (path, method = 'GET', body) => fetch(env.TUNNEL_PUBLIC_URL + path, {method, headers: {'content-type': 'application/json', authorization: 'Bearer test-api-token'}, body: body ? JSON.stringify(body) : undefined});
  const response = await api('/api/apply', 'POST', {});
  assert.equal(response.status, 200, '离线后端不能让整次发布失败');
  const report = await response.json();
  assert.equal(report.state, 'success');
  assert.deepEqual([...report.routes].sort(), ['dead', 'live'], '不可达条目也要照常下发路由');
  assert.deepEqual(report.warnings, [`dead（127.0.0.1:${deadPort}）`]);
  assert.equal(published.length, 1);
  const hosts = published[0].apps.http.servers.test.routes.flatMap(route => (route.match ?? []).flatMap(match => match.host ?? []));
  assert.ok(hosts.includes('dead.example.test') && hosts.includes('live.example.test'));
  const stored = JSON.parse(readFileSync(join(dir, 'last-apply.json'), 'utf8'));
  assert.deepEqual(stored.warnings, [`dead（127.0.0.1:${deadPort}）`], '发布记录要留下可排查的不可达条目');
  assert.match(stored.steps.find(step => step.step === '设备与目标端口').detail, /上游暂不可达/);
});
