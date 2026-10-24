#!/usr/bin/env node
import {createServer, request} from 'node:http';
import {readFileSync, chmodSync} from 'node:fs';
import {createDecipheriv} from 'node:crypto';
import pg from 'pg';
import {equal} from '../server/access.js';
import {required} from '../server/settings.js';

const host = JSON.parse(readFileSync(required('AIO_PLUGIN_CONFIG'), 'utf8'));
const socket = required('AIO_PLUGIN_SOCKET');
const database = host.database_url ? new pg.Pool({connectionString: host.database_url, max: 1}) : undefined;

function open(value: string): string {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(host.encryption_key, 'base64'), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
}

async function configuration() {
  if (database) {
    const row = (await database.query('SELECT endpoint,token,users FROM tunnel_connection WHERE id=1')).rows[0];
    if (!row) { throw new Error('服务入口尚未配置连接，请联系管理员'); }
    if (!host.http_endpoints?.includes(row.endpoint)) { throw new Error('服务入口未获宿主网络授权'); }
    return {...row, token: open(row.token)};
  }
  return {endpoint: required('TUNNEL_URL'), token: required('TUNNEL_API_TOKEN'), users: required('TUNNEL_AIO_USERS').split(',')};
}

function broker(endpoint: string, token: string, body: unknown): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const call = request({socketPath: host.broker_socket, path: '/egress/http', method: 'POST', headers: {'x-aio-token': host.ingress_token, 'x-aio-endpoint': endpoint, 'x-aio-method': 'POST', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}}, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({status: response.statusCode ?? 502, body: text}));
    });
    call.on('error', reject); call.setTimeout(30_000, () => call.destroy(new Error('服务入口响应超时'))); call.end(payload);
  });
}

const server = createServer(async (req, res) => {
  const send = (status: number, value: unknown) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(value)); };
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/health') { send(200, {status: 'ok'}); return; }
  if (req.method === 'GET' && path === '/aio/describe') {
    send(200, {label: '服务入口', pages: [{id: 'tunnel', label: '服务入口', entry: 'index.html', scene: ['workspace', '工作空间'], menu_path: [], permission: null, surface: 'workspace'}]}); return;
  }
  if (!equal(String(req.headers['x-aio-token'] ?? ''), host.ingress_token) || req.headers['x-aio-tenant-id'] !== host.tenant_id) { send(403, {error: 'AIO identity rejected'}); return; }
  if (!/^\/api\/(services(?:\/[a-z0-9-]+)?|apply|devices|accounts|publications)$/.test(path)) { send(404, {error: 'Not found'}); return; }
  try {
    const config = await configuration();
    const user = String(req.headers['x-aio-user-id'] ?? '');
    if (!config.users.includes(user)) { send(403, {error: '当前用户没有基础设施管理权限'}); return; }
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32_768) { throw new Error('请求超过大小限制'); } }
    if (host.broker_socket) {
      const result = await broker(config.endpoint, config.token, {tenant: host.tenant_id, user, method: req.method, path, body: text ? JSON.parse(text) : undefined});
      if (result.status !== 200) { send(502, {error: '服务入口连接失败，请检查宿主网络授权'}); return; }
      const envelope = JSON.parse(result.body);
      send(envelope.status, envelope.body); return;
    }
    // 本地接口测试使用直连；生产沙箱只允许宿主 broker 出站。
    const result = await fetch(new URL(path, config.endpoint), {method: req.method, headers: {authorization: `Bearer ${config.token}`, 'content-type': 'application/json'}, body: text || undefined, redirect: 'error', signal: AbortSignal.timeout(30_000)});
    res.writeHead(result.status, {'content-type': 'application/json'}); res.end(await result.text());
  } catch (error) { send(502, {error: error instanceof Error ? error.message : '服务入口请求失败'}); }
});
// 宿主与隔离进程使用不同 UID；外层目录由宿主以 0700 保护，业务调用仍校验令牌。
server.listen(socket, () => { chmodSync(socket, 0o666); console.log('Tunnel sidecar ready'); });
process.on('SIGTERM', () => server.close(async () => { await database?.end(); process.exit(0); }));
