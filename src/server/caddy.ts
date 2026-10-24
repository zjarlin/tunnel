import {request, Agent} from 'node:http';
import type {Alias, PortalSettings} from '../config/index.js';

// 只操作预先挂载的命名路由，不替换其他应用的 Caddy 配置。
export function caddyRequest(endpoint: string, path: string, method = 'GET', body?: unknown, agent?: Agent): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const connection = endpoint.startsWith('http:') ? {hostname: new URL(endpoint).hostname, port: new URL(endpoint).port, agent} : {socketPath: endpoint};
    const req = request({...connection, path, method, headers: payload ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)} : {}}, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; if (text.length > 1_000_000) { req.destroy(new Error('Caddy response too large')); } });
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 300) { reject(new Error(`Caddy HTTP ${response.statusCode}: ${text.slice(0, 200)}`)); return; }
        try { resolve(text ? JSON.parse(text) : null); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Caddy request timeout')));
    req.end(payload);
  });
}

export function routes(settings: PortalSettings, aliases: Alias[]): unknown[] {
  return aliases.map(item => {
    const proxy = {handler: 'reverse_proxy', upstreams: [{dial: `${item.host}:${item.port}`}], ...(item.scheme === 'https' ? {transport: {protocol: 'http', tls: {}}} : {})};
    const handlers = item.visibility === 'public'
      ? [proxy]
      : [{handler: 'subroute', routes: [
          {match: [{remote_ip: {ranges: settings.caddy?.allow ?? []}}], handle: [proxy], terminal: true},
          {handle: [{handler: 'static_response', status_code: 404}]},
        ]}];
    return {match: [{host: [`${item.alias}.${settings.suffix}`]}], handle: handlers, terminal: true};
  });
}

export async function publish(settings: PortalSettings, aliases: Alias[], endpoint: string): Promise<void> {
  const id = 'tunnel-services';
  let failure: unknown;
  // 共享端口存在多个 Caddy 时，命名路由探测和写入复用同一条连接。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const agent = new Agent({keepAlive: true, maxSockets: 1});
    try {
      const config = await caddyRequest(endpoint, '/config/', 'GET', undefined, agent) as {apps?: {http?: {servers?: Record<string, {routes?: unknown[]}>}}};
      const consoleHost = new URL(process.env.TUNNEL_PUBLIC_URL ?? 'http://localhost').hostname;
      const servers = config.apps?.http?.servers ?? {};
      const server = Object.entries(servers).find(([, value]) => JSON.stringify(value.routes).includes(`"${consoleHost}"`));
      if (!server) { throw new Error('Caddy console route is not installed on this instance'); }
      const [name, current] = server;
      const managed = {match: [{host: aliases.map(item => `${item.alias}.${settings.suffix}`)}], handle: [{'@id': id, handler: 'subroute', routes: routes(settings, aliases)}]};
      const existing = (current.routes ?? []).findIndex(route => JSON.stringify(route).includes(`"@id":"${id}"`));
      if (existing >= 0 && JSON.stringify(current.routes?.[existing]) === JSON.stringify(managed)) { return; }
      if (existing < 0 && !aliases.length) { return; }
      const configured = config as {apps: {tls?: {automation?: {policies?: Array<Record<string, unknown>>}}}};
      const policies = configured.apps.tls?.automation?.policies ?? [];
      const issuerId = 'tunnel-internal-certificates';
      const issuerIndex = policies.findIndex(policy => policy['@id'] === issuerId);
      const internal = aliases.filter(item => item.visibility !== 'public').map(item => `${item.alias}.${settings.suffix}`);
      if (internal.length) {
        const policy = {'@id': issuerId, subjects: internal, issuers: [{module: 'internal'}]};
        if (issuerIndex >= 0) {
          await caddyRequest(endpoint, `/config/apps/tls/automation/policies/${issuerIndex}`, 'PATCH', policy, agent);
        } else {
          await caddyRequest(endpoint, '/config/apps/tls/automation/policies', 'POST', policy, agent);
        }
      } else if (issuerIndex >= 0) {
        await caddyRequest(endpoint, `/config/apps/tls/automation/policies/${issuerIndex}`, 'DELETE', undefined, agent);
      }
      if (existing >= 0 && !aliases.length) {
        await caddyRequest(endpoint, `/config/apps/http/servers/${name}/routes/${existing}`, 'DELETE', undefined, agent);
      } else if (existing >= 0) {
        await caddyRequest(endpoint, `/config/apps/http/servers/${name}/routes/${existing}`, 'PATCH', managed, agent);
      } else if (aliases.length) {
        await caddyRequest(endpoint, `/config/apps/http/servers/${name}/routes/0`, 'PUT', managed, agent);
      }
      return;
    } catch (error) { failure = error; }
    finally { agent.destroy(); }
  }
  throw failure;
}
