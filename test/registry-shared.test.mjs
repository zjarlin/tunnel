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
 * 注册表是唯一真相源：182 内网（localmesh）与外部入口（home-edge）共用一份文件，
 * 每个入口只渲染自己那一份，控制台保存也不能把别的入口归属抹掉。
 */
test('shared registry: console lists every edge but only publishes its own', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-registry-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const published = [];
  const caddy = createServer(async (req, res) => {
    if (req.method === 'POST') { let body = ''; for await (const chunk of req) { body += chunk; } published.push(JSON.parse(body)); }
    res.setHeader('etag', '"/config/ test"');
    res.end(JSON.stringify({apps: {http: {servers: {test: {routes: [{match: [{host: ['127.0.0.1']}]}]}}}}}));
  });
  caddy.listen(0, '127.0.0.1'); await once(caddy, 'listening');

  const registryFile = join(dir, 'aliases.json');
  writeFileSync(registryFile, JSON.stringify({aliases: [
    // 历史条目：没有 edges 字段，仍然归本服务发布。
    {alias: 'alpha', host: '127.0.0.1', port: 8081, scheme: 'http', visibility: 'internal', note: 'legacy'},
    // 182 内网条目：只由 aio-portal 渲染 localmesh。
    {alias: 'beta', host: '127.0.0.1', port: 8082, scheme: 'http', visibility: 'internal', note: 'lan only', edges: ['localmesh'], suffix: 'example.test', stream: true},
    // 停用条目：两个入口都不渲染。
    {alias: 'gamma', host: '127.0.0.1', port: 8083, scheme: 'http', visibility: 'internal', note: 'retired', edges: ['home-edge'], disabled: true},
  ]}));

  const env = {...process.env, TUNNEL_DATA: dir, TUNNEL_REGISTRY_FILE: registryFile, TUNNEL_DOMAIN: 'example.test', TUNNEL_RAW_HOST: 'raw.example.test', TUNNEL_LAN_IP: '127.0.0.1', TUNNEL_ALLOWED_CIDRS: '127.0.0.1/32', TUNNEL_BIND: '127.0.0.1', TUNNEL_PORT: String(port), TUNNEL_PUBLIC_URL: `http://127.0.0.1:${port}`, TUNNEL_ADMIN_USER: 'tester', TUNNEL_ADMIN_PASSWORD: 'test-only-password', TUNNEL_API_TOKEN: 'test-api-token', TUNNEL_CADDY_ADMIN: `http://127.0.0.1:${caddy.address().port}`, TUNNEL_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), TUNNEL_TCP_CATALOG: join(dir, 'tcp.json'), TUNNEL_CF_TOKEN: '', TUNNEL_CF_ZONE: ''};
  writeFileSync(env.TUNNEL_TCP_CATALOG, JSON.stringify({version: 1, items: []}));
  const child = spawn(process.execPath, ['dist/server.mjs'], {env, stdio: ['ignore', 'pipe', 'inherit']});
  t.after(async () => { child.kill(); caddy.closeAllConnections(); await new Promise(resolve => caddy.close(resolve)); rmSync(dir, {recursive: true, force: true}); });
  await ready(child);

  const base = env.TUNNEL_PUBLIC_URL;
  const auth = {authorization: 'Bearer test-api-token'};
  const api = (path, method = 'GET', body) => fetch(base + path, {method, headers: {'content-type': 'application/json', ...auth}, body: body ? JSON.stringify(body) : undefined});

  const listed = await (await api('/api/services')).json();
  assert.deepEqual(listed.items.map(item => item.alias), ['alpha', 'beta', 'gamma'], '控制台必须看到全部入口共用的登记');
  assert.deepEqual(listed.items.find(item => item.alias === 'beta').edges, ['localmesh']);

  assert.equal((await api('/api/apply', 'POST', {})).status, 200);
  assert.equal(published.length, 1);
  const hosts = published[0].apps.http.servers.test.routes
    .flatMap(route => (route.match ?? []).flatMap(match => match.host ?? []));
  // 假 Caddy 里保留了控制台自身站点的 127.0.0.1，这里只关心服务域名。
  const services = hosts.filter(host => host.endsWith('.example.test'));
  assert.deepEqual(services, ['alpha.example.test'], '只发布 home-edge 名下且未停用的条目');

  // 控制台保存不能把别的入口归属与 portal 侧字段抹掉。
  assert.equal((await api('/api/services', 'PUT', {alias: 'beta', host: '127.0.0.1', port: 8092, scheme: 'http', visibility: 'internal', note: 'edited in console'})).status, 200);
  const saved = JSON.parse(readFileSync(registryFile, 'utf8')).aliases.find(item => item.alias === 'beta');
  assert.equal(saved.port, 8092);
  assert.deepEqual(saved.edges, ['localmesh'], '保存后仍归 localmesh 渲染');
  assert.equal(saved.stream, true, 'portal 侧字段原样保留');
  assert.equal(saved.suffix, 'example.test');
});
