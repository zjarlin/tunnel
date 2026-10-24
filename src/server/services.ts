import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {isIP} from 'node:net';
import type {Alias, PortalSettings} from '../config/index.js';
import {readAliases, upsert, remove} from '../portal/registry.js';
import {render} from '../portal/render.js';
import {dnsProvider} from '../portal/providers.js';
import {publish} from './caddy.js';

export function validate(value: Record<string, unknown>): Alias {
  const {alias, host, port, scheme, visibility, note} = value;
  if (typeof alias !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias)) { throw new Error('Invalid alias'); }
  if (typeof host !== 'string' || !(isIP(host) === 4 || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) { throw new Error('Invalid target host'); }
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) { throw new Error('Invalid port'); }
  if (scheme !== 'http' && scheme !== 'https') { throw new Error('Invalid scheme'); }
  if (visibility !== 'internal' && visibility !== 'public') { throw new Error('Invalid visibility'); }
  if (typeof note !== 'string' || note.length > 300) { throw new Error('Invalid note'); }
  return {alias, host, port: Number(port), scheme, visibility, note, authorizedBy: visibility === 'public' ? 'console-admin' : undefined};
}

export function serviceRegistry(settings: PortalSettings, socket: string) {
  let active = false;
  const assertIdle = () => { if (active) { throw new Error('An apply operation is already running'); } };
  return {
    list: () => readAliases(settings),
    save: (value: Record<string, unknown>) => {
      assertIdle();
      const entry = validate(value);
      const name = `${entry.alias}.${settings.suffix}`;
      if ([new URL(process.env.TUNNEL_PUBLIC_URL ?? 'http://localhost').hostname, process.env.TUNNEL_RAW_HOST].includes(name)) {
        throw new Error('The console and raw entry hostnames are reserved');
      }
      return upsert(settings, entry);
    },
    remove: (alias: string) => { assertIdle(); return remove(settings, alias); },
    async recover() {
      const file = `${settings.portal.root}/published.json`;
      if (active || !existsSync(file)) { return; }
      active = true;
      try { await publish(settings, JSON.parse(readFileSync(file, 'utf8')), socket); }
      finally { active = false; }
    },
    async apply() {
      if (active) { throw new Error('An apply operation is already running'); }
      active = true;
      try {
        const aliases = readAliases(settings);
        // 所有 DNS 计划先通过，才发布任何路由；内网服务不调用云 DNS。
        const entries = await Promise.all(aliases.map(async item => {
          const provider = dnsProvider(settings, item);
          return {item, provider, plan: item.visibility === 'public' ? await provider.plan(item, settings) : null};
        }));
        const blocked = entries.filter(entry => entry.plan?.blocked);
        if (blocked.length) { throw new Error(blocked.map(entry => `${entry.item.alias}: ${entry.plan?.warnings.join('; ')}`).join('\n')); }
        await publish(settings, aliases, socket);
        render(settings);
        const verified = [];
        for (const {item, provider, plan} of entries) {
          if (plan) {
            await provider.apply(item, settings, plan);
            const check = await provider.verify(item, settings);
            if (!check.ok) { throw new Error(`${item.alias}: ${check.detail}`); }
          }
          verified.push(item.alias);
        }
        const report = {at: new Date().toISOString(), routes: verified, dns: 'Internal DNS fragment generated; resolver reload is managed by the host'};
        writeFileSync(`${settings.portal.root}/published.json`, JSON.stringify(aliases), {mode: 0o600});
        writeFileSync(`${settings.portal.root}/last-apply.json`, JSON.stringify(report), {mode: 0o600});
        return report;
      } finally { active = false; }
    },
  };
}
