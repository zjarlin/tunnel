import {createServer, type IncomingMessage} from 'node:http';
import {readFileSync} from 'node:fs';
import {access} from './access.js';
import {settings, required} from './settings.js';
import {serviceRegistry} from './services.js';

const config = settings();
const origin = new URL(required('TUNNEL_PUBLIC_URL')).origin;
const allowedOrigins = new Set([origin, ...(process.env.TUNNEL_EXTRA_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
  const url = new URL(value);
  const canonical = new URL(origin);
  if (url.origin !== value || url.hostname !== canonical.hostname || url.protocol !== canonical.protocol) { throw new Error('TUNNEL_EXTRA_ORIGINS 只能包含控制台同协议、同域名的其他端口来源'); }
  return value;
})]);
const login = access(required('TUNNEL_ADMIN_USER'), required('TUNNEL_ADMIN_PASSWORD'), required('TUNNEL_API_TOKEN'));
const services = serviceRegistry(config, required('TUNNEL_CADDY_ADMIN'));
const assets: Record<string, [string, string]> = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css']};

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) { throw new Error('JSON body required'); }
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 32_768) { throw new Error('Request too large'); }
  }
  return JSON.parse(text);
}

const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
  let aio = false;
  const send = (status: number, value: unknown) => { response.writeHead(aio ? 200 : status, {'content-type': 'application/json'}); response.end(JSON.stringify(aio ? {status, body: value} : value)); };
  try {
    let path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') { send(200, {status: 'ok', service: 'tunnel', version: '0.4.0'}); return; }
    if (request.method === 'GET' && assets[path]) {
      const [file, type] = assets[path];
      response.writeHead(200, {'content-type': `${type}; charset=utf-8`});
      response.end(readFileSync(new URL(`./web/${file}`, import.meta.url))); return;
    }
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) { send(403, {error: 'Origin rejected'}); return; }
    if (request.method === 'POST' && path === '/api/login') {
      const data = await body(request);
      const token = login.login(String(data.user ?? ''), String(data.password ?? ''), request.socket.remoteAddress ?? 'unknown');
      response.setHeader('set-cookie', `tunnel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith('https:') ? '; Secure' : ''}`);
      send(200, {ok: true}); return;
    }
    if (!login.authorized(request)) { send(401, {error: 'Login required'}); return; }
    let method = request.method;
    let forwarded: Record<string, unknown> | undefined;
    if (method === 'POST' && path === '/api/aio') {
      // 仅服务端令牌可接受宿主断言，浏览器 cookie 不能伪造 AIO 用户。
      if (request.headers.authorization !== `Bearer ${required('TUNNEL_API_TOKEN')}`) { send(403, {error: 'AIO adapter token required'}); return; }
      const envelope = await body(request);
      if (!(process.env.TUNNEL_AIO_TENANTS ?? required('TUNNEL_AIO_TENANT')).split(',').includes(String(envelope.tenant)) || !required('TUNNEL_AIO_USERS').split(',').includes(String(envelope.user))) { send(403, {error: 'AIO identity rejected'}); return; }
      aio = true;
      path = String(envelope.path); method = String(envelope.method); forwarded = (envelope.body ?? {}) as Record<string, unknown>;
    }
    const data = () => forwarded ? Promise.resolve(forwarded) : body(request);
    if (request.method === 'POST' && path === '/api/logout') {
      login.logout(request); response.setHeader('set-cookie', 'tunnel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send(200, {ok: true}); return;
    }
    if (method === 'GET' && path === '/api/services') { send(200, {domain: config.suffix, items: services.list(), status: services.status()}); return; }
    if (method === 'PUT' && path === '/api/services') { send(200, services.save(await data())); return; }
    if (method === 'DELETE' && path.startsWith('/api/services/')) { send(200, services.remove(decodeURIComponent(path.slice('/api/services/'.length)))); return; }
    if (method === 'GET' && path === '/api/devices') { send(200, {items: await services.devices.list()}); return; }
    if (method === 'PUT' && path === '/api/devices') { send(200, await services.devices.bind(await data())); return; }
    if (method === 'GET' && path === '/api/accounts') { send(200, {items: services.accounts.list()}); return; }
    if (method === 'PUT' && path === '/api/accounts') { send(200, services.accounts.save(await data())); return; }
    if (method === 'GET' && path === '/api/publications') { send(200, services.status()); return; }
    if (method === 'POST' && path === '/api/publications') {
      await data();
      services.assertIdle();
      services.apply().catch(() => { /* 失败详情持久化在发布状态中，由界面读取。 */ });
      send(202, {state: 'running'}); return;
    }
    if (method === 'POST' && path === '/api/apply') { await data(); send(200, await services.apply()); return; }
    send(404, {error: 'Not found'});
  } catch (error) { send(400, {error: error instanceof Error ? error.message : 'Request failed'}); }
});
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
server.listen(Number(required('TUNNEL_PORT')), required('TUNNEL_BIND'), () => console.log('Tunnel server ready'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

// Caddy 热加载后恢复上次成功发布的路由，不自动发布尚未应用的表格草稿。
const recovery = setInterval(async () => {
  try { await services.recover(); }
  catch (error) { console.error('Caddy route recovery:', error instanceof Error ? error.message : String(error)); }
}, 30_000);
recovery.unref();
