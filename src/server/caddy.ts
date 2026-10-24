import {request, Agent} from 'node:http';
import type {Alias, PortalSettings} from '../config/index.js';

type CaddyConfig = {
  apps: {
    http: {servers: Record<string, {listen?: string[]; routes?: Array<Record<string, unknown>>}>};
    tls?: {automation?: {policies?: Array<Record<string, unknown>>}};
  };
};

// 读取 ETag 后只提交一次带条件的配置更新，避免覆盖并发管理者的修改。
export function caddyRequest(endpoint: string, path: string, method = 'GET', body?: unknown, agent?: Agent, metadata?: {etag?: string}, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const connection = endpoint.startsWith('http:') ? {hostname: new URL(endpoint).hostname, port: new URL(endpoint).port, agent} : {socketPath: endpoint};
    const req = request({...connection, path, method, headers: {...headers, ...(payload ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)} : {})}}, response => {
      let text = '';
      if (metadata) { metadata.etag = response.headers.etag; }
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
  const consoleHost = new URL(process.env.TUNNEL_PUBLIC_URL ?? 'http://localhost').hostname;
  const listener = process.env.TUNNEL_CADDY_LISTENER;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const agent = new Agent({keepAlive: true, maxSockets: 1});
    try {
      const metadata: {etag?: string} = {};
      const config = await caddyRequest(endpoint, '/config/', 'GET', undefined, agent, metadata) as CaddyConfig;
      const server = Object.values(config.apps.http.servers).find(value => (!listener || value.listen?.includes(listener)) && JSON.stringify(value.routes).includes(`"${consoleHost}"`));
      if (!server) { continue; }
      const managed = {match: [{host: aliases.map(item => `${item.alias}.${settings.suffix}`)}], handle: [{'@id': id, handler: 'subroute', routes: routes(settings, aliases)}]};
      const existing = (server.routes ?? []).findIndex(route => JSON.stringify(route).includes(`"@id":"${id}"`));
      if (existing >= 0 && JSON.stringify(server.routes?.[existing]) === JSON.stringify(managed)) { return; }
      if (existing < 0 && !aliases.length) { return; }
      const other = (server.routes ?? []).filter((_, index) => index !== existing);
      for (const alias of aliases) {
        const domain = `${alias.alias}.${settings.suffix}`;
        if (JSON.stringify(other).includes(`"${domain}"`)) { throw new Error(`Caddy already manages ${domain} outside Tunnel`); }
      }
      server.routes = aliases.length ? [managed, ...other] : other;
      config.apps.tls ??= {};
      config.apps.tls.automation ??= {};
      const issuerId = 'tunnel-internal-certificates';
      const policies = (config.apps.tls.automation.policies ?? []).filter(policy => policy['@id'] !== issuerId);
      const internal = aliases.filter(item => item.visibility !== 'public').map(item => `${item.alias}.${settings.suffix}`);
      if (internal.length) { policies.unshift({'@id': issuerId, subjects: internal, issuers: [{module: 'internal'}]}); }
      config.apps.tls.automation.policies = policies;
      if (!metadata.etag) { throw new Error('Caddy did not return an ETag; refusing an unguarded config update'); }
      await caddyRequest(endpoint, '/config/', 'POST', config, agent, undefined, {'if-match': metadata.etag});
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Caddy HTTP 412')) { continue; }
      throw error;
    } finally { agent.destroy(); }
  }
  throw new Error('Caddy console route/listener not found or config changed concurrently');
}
