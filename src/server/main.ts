import {createServer, type IncomingMessage} from 'node:http';
import {readFileSync} from 'node:fs';
import {access} from './access.js';
import {settings, required} from './settings.js';
import {serviceRegistry} from './services.js';

const config = settings();
const origin = new URL(required('TUNNEL_PUBLIC_URL')).origin;
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
  const send = (status: number, value: unknown) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value)); };
  try {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') { send(200, {status: 'ok', service: 'tunnel', version: '0.3.0'}); return; }
    if (request.method === 'GET' && assets[path]) {
      const [file, type] = assets[path];
      response.writeHead(200, {'content-type': `${type}; charset=utf-8`});
      response.end(readFileSync(new URL(`./web/${file}`, import.meta.url))); return;
    }
    if (request.headers.origin && request.headers.origin !== origin) { send(403, {error: 'Origin rejected'}); return; }
    if (request.method === 'POST' && path === '/api/login') {
      const data = await body(request);
      const token = login.login(String(data.user ?? ''), String(data.password ?? ''), request.socket.remoteAddress ?? 'unknown');
      response.setHeader('set-cookie', `tunnel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith('https:') ? '; Secure' : ''}`);
      send(200, {ok: true}); return;
    }
    if (!login.authorized(request)) { send(401, {error: 'Login required'}); return; }
    if (request.method === 'POST' && path === '/api/logout') {
      login.logout(request); response.setHeader('set-cookie', 'tunnel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send(200, {ok: true}); return;
    }
    if (request.method === 'GET' && path === '/api/services') { send(200, {domain: config.suffix, items: services.list()}); return; }
    if (request.method === 'PUT' && path === '/api/services') { send(200, services.save(await body(request))); return; }
    if (request.method === 'DELETE' && path.startsWith('/api/services/')) { send(200, services.remove(decodeURIComponent(path.slice('/api/services/'.length)))); return; }
    if (request.method === 'POST' && path === '/api/apply') { await body(request); send(200, await services.apply()); return; }
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
