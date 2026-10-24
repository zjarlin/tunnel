import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import type {PortalSettings} from '../config/index.js';

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) { throw new Error(`${name} is required`); }
  return value;
}

export function settings(): PortalSettings {
  const root = resolve(required('TUNNEL_DATA'));
  const suffix = required('TUNNEL_DOMAIN');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(suffix)) {
    throw new Error('TUNNEL_DOMAIN must be a domain');
  }
  mkdirSync(root, {recursive: true, mode: 0o700});
  return {
    suffix, mode: 'lan', lanIp: required('TUNNEL_LAN_IP'),
    resolver: {port: 53, upstreams: [], provider: 'none', fragment: true, configFile: `${root}/dns/tunnel.conf`},
    portal: {root, aliasesDir: `${root}/nginx`, mapPrefix: 'tunnel', reload: false},
    gateway: {adapter: 'none'},
    caddy: {sitesDir: `${root}/caddy`, prefix: 'tunnel-', bind: required('TUNNEL_LAN_IP'), allow: required('TUNNEL_ALLOWED_CIDRS').split(',')},
    providers: {
      dns: 'cloudflare', connectivity: 'caddy', certificate: 'internal-ca', policy: 'lan-allowlist',
      cloud: {cloudflare: {enabled: true, zone: process.env.TUNNEL_CF_ZONE, credentialsEnv: 'TUNNEL_CF_TOKEN', cnameTarget: required('TUNNEL_RAW_HOST'), allowPublicWrite: Boolean(process.env.TUNNEL_CF_TOKEN)}},
    },
  };
}
