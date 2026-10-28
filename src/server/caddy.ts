import {request, Agent} from 'node:http';
import {serviceSuffix, type Alias, type PortalSettings} from '../config/index.js';
import type {Certificate} from './certificates.js';

type CaddyConfig = {
  apps: {
    http: {servers: Record<string, {listen?: string[]; routes?: Array<Record<string, unknown>>; tls_connection_policies?: Array<Record<string, unknown>>}>};
    tls?: {automation?: {policies?: Array<Record<string, unknown>>}; certificates?: {load_pem?: Certificate[]}};
  };
};

export const serviceDomain = (settings: PortalSettings, item: Alias) => `${item.alias}.${serviceSuffix(settings, item)}`;

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
    req.setTimeout(55_000, () => req.destroy(new Error('Caddy request timeout')));
    req.end(payload);
  });
}

export function routes(settings: PortalSettings, aliases: Alias[]): unknown[] {
  return aliases.map(item => {
    const proxy = {handler: 'reverse_proxy', upstreams: [{dial: `${item.host}:${item.port}`}], ...(item.scheme === 'https' ? {transport: {protocol: 'http', tls: item.tlsServerName ? {server_name: item.tlsServerName} : {}}} : {})};
    const handlers = item.visibility === 'public'
      ? [proxy]
      : [{handler: 'subroute', routes: [
          {match: [{remote_ip: {ranges: settings.caddy?.allow ?? []}}], handle: [proxy], terminal: true},
          {handle: [{handler: 'static_response', status_code: 404}]},
        ]}];
    return {match: [{host: [serviceDomain(settings, item)]}], handle: handlers, terminal: true};
  });
}

/**
 * 定位「该由哪个 Caddy server 承载服务路由」。
 *
 * 以前靠控制台自己的域名出现在路由里来认这个 server；控制台下线后这个线索不存在了，
 * 因此改为显式声明 `TUNNEL_CADDY_HOSTS`（该实例上的既有站点名）。控制台域名和已接管的
 * `tunnel-services` 路由仍作为回落线索，保证老部署和尚未填写新变量时行为不变。
 */
export function locate(settings: PortalSettings, aliases: Alias[], config: CaddyConfig, listener?: string): Array<[string, {listen?: string[]; routes?: Array<Record<string, unknown>>; tls_connection_policies?: Array<Record<string, unknown>>}]> {
  const explicit = (process.env.TUNNEL_CADDY_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const consoleHost = process.env.TUNNEL_PUBLIC_URL ? new URL(process.env.TUNNEL_PUBLIC_URL).hostname : '';
  // 线索按优先级排列：显式声明 > 已接管路由 > 控制台域名。任一条命中即认定该 server 归本服务管理。
  const clues = ['"@id":"tunnel-services', ...explicit.map(item => JSON.stringify(item)), ...(consoleHost ? [JSON.stringify(consoleHost)] : [])];
  return Object.entries(config.apps.http.servers).filter(([, value]) => {
    if (listener && listener !== '*' && !value.listen?.includes(listener)) { return false; }
    const text = JSON.stringify(value.routes ?? []);
    if (!clues.some(clue => text.includes(clue))) { return false; }
    // 已接管的 server 即使别名清空也要继续认领，否则最后一条登记删不掉旧路由。
    return true;
  });
}

export async function publish(settings: PortalSettings, aliases: Alias[], endpoint: string, certificates: Certificate[] = []): Promise<void> {
  const listener = process.env.TUNNEL_CADDY_LISTENER;
  const expected = Number(process.env.TUNNEL_CADDY_INSTANCES || 1);
  const seen = new Set<string>();
  // 「实例数」用来兼容多个 Caddy 同时服务控制台域名的情况；但实际实例数可能少于配置值
  // （例如 :80 的跳转 server 被其他系统重整掉）。这里额外用「连续两轮配置完全相同」判定
  // 已经处理完当前所有实例，避免配置收敛后仍空转到 24 轮然后误报并发冲突。
  let stable: string | undefined;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const agent = new Agent({keepAlive: true, maxSockets: 1});
    try {
      const metadata: {etag?: string} = {};
      const config = await caddyRequest(endpoint, '/config/', 'GET', undefined, agent, metadata) as CaddyConfig;
      const servers = locate(settings, aliases, config, listener);
      if (!servers.length) { continue; }
      const identity = JSON.stringify(servers.map(([name,value]) => [name,value.listen]));
      if (seen.has(identity)) {
        // 两轮读到的实例集合一致：当前配置里已没有未处理的实例，可以收工。
        if (stable === identity) { return; }
        continue;
      }
      let changed = false;
      for (const [serverName,server] of servers) {
        const id = `tunnel-services-${serverName}`;
        const managed = {match: [{host: aliases.map(item => serviceDomain(settings, item))}], handle: [{'@id': id, handler: 'subroute', routes: routes(settings, aliases)}]};
        const original = JSON.stringify(server.routes);
        const other = (server.routes ?? []).filter(route => !JSON.stringify(route).includes('"@id":"tunnel-services'));
        for (const item of aliases) {
          const domain = serviceDomain(settings, item);
          const conflict = other.findIndex(route => JSON.stringify(route).includes(`"${domain}"`));
          if (conflict < 0) { continue; }
          const route = other[conflict];
          const match = route.match as Array<{host?: string[]}> | undefined;
          const explicitlyAdopted = (process.env.TUNNEL_ADOPT_DOMAINS ?? '').split(',').includes(domain);
          if (!explicitlyAdopted || match?.length !== 1 || match[0].host?.length !== 1 || match[0].host[0] !== domain || !JSON.stringify(route).includes(`"${item.host}:${item.port}"`)) {
            throw new Error(`Caddy already manages ${domain} outside Tunnel`);
          }
          other.splice(conflict,1);
        }
        server.routes = aliases.length ? [managed, ...other] : other;
        changed ||= original !== JSON.stringify(server.routes);
        // 内部 CA 的旧证书可能仍在 Caddy 缓存中，按 SNI 明确选择新签发的证书。
        const previousTls = server.tls_connection_policies;
        const unmanagedTls = (previousTls ?? [{}]).filter(policy => {
          const selection = policy.certificate_selection as {any_tag?: string[]} | undefined;
          return !selection?.any_tag?.some(tag => tag.startsWith('tunnel-service:'));
        });
        const selectedTls = certificates.flatMap(cert => cert.tags.filter(tag => tag.startsWith('tunnel-service:')).map(tag => ({
          match: {sni: [tag.slice('tunnel-service:'.length)]}, certificate_selection: {any_tag: [tag]},
        })));
        if (selectedTls.length || previousTls) {
          server.tls_connection_policies = [...selectedTls, ...unmanagedTls];
          changed ||= JSON.stringify(previousTls) !== JSON.stringify(server.tls_connection_policies);
        }
      }
      config.apps.tls ??= {};
      config.apps.tls.certificates ??= {};
      const loaded = config.apps.tls.certificates.load_pem ?? [];
      const next = [...loaded.filter(cert => !cert.tags?.some(tag => tag.startsWith('tunnel-service:'))), ...certificates];
      changed ||= JSON.stringify(loaded) !== JSON.stringify(next);
      config.apps.tls.certificates.load_pem = next;
      config.apps.tls.automation ??= {};
      const issuerId = 'tunnel-internal-certificates';
      const managedDomains = new Set(aliases.map(item => serviceDomain(settings, item)));
      const policies = (config.apps.tls.automation.policies ?? [])
        .filter(policy => policy['@id'] !== issuerId)
        .map(policy => Array.isArray(policy.subjects) ? {...policy, subjects: policy.subjects.filter(subject => !managedDomains.has(String(subject)))} : policy)
        .filter(policy => !Array.isArray(policy.subjects) || policy.subjects.length > 0);
      const secured = new Set(certificates.flatMap(cert => cert.tags.map(tag => tag.replace(/^tunnel-service:/, ''))));
      const internal = aliases.filter(item => item.visibility !== 'public').map(item => serviceDomain(settings, item)).filter(domain => !secured.has(domain));
      if (internal.length) { policies.unshift({'@id': issuerId, subjects: internal, issuers: [{module: 'internal'}]}); }
      changed ||= JSON.stringify(config.apps.tls.automation.policies) !== JSON.stringify(policies);
      config.apps.tls.automation.policies = policies;
      if (changed) {
        if (!metadata.etag) { throw new Error('Caddy did not return an ETag; refusing an unguarded config update'); }
        await caddyRequest(endpoint, '/config/', 'POST', config, agent, undefined, {'if-match': metadata.etag});
      }
      seen.add(identity);
      stable = identity;
      if (seen.size >= expected) { return; }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Caddy HTTP 412')) { stable = undefined; continue; }
      throw error;
    } finally { agent.destroy(); }
  }
  throw new Error('Caddy console route/listener not found or config changed concurrently');
}
