import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import type {Alias, PortalSettings} from '../config/index.js';
import {readAliases, upsert, remove} from '../portal/registry.js';
import {dnsProvider} from '../portal/providers.js';
import {publish, serviceDomain} from './caddy.js';
import {deviceDirectory, probe, validHost} from './devices.js';
import {accounts} from './accounts.js';
import {dnsPlan} from './cloud-dns.js';
import {certificates} from './certificates.js';

export function validate(value: Record<string, unknown>): Alias {
  const {alias, port, scheme, visibility, note} = value;
  const host = String(value.host || '');
  const deviceId = String(value.deviceId || '');
  const accountId = String(value.accountId || '');
  const domain = String(value.domain || '');
  const dnsMode = value.dnsMode ?? 'managed';
  if (typeof alias !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias)) { throw new Error('域名别名无效'); }
  if ((!deviceId || host) && !validHost(host)) { throw new Error('目标主机无效'); }
  if (domain && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) { throw new Error('域名后缀无效'); }
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) { throw new Error('端口必须在 1～65535 之间'); }
  if (scheme !== 'http' && scheme !== 'https') { throw new Error('协议无效'); }
  if (visibility !== 'internal' && visibility !== 'public') { throw new Error('访问范围无效'); }
  if (dnsMode !== 'managed' && dnsMode !== 'existing') { throw new Error('DNS 方式无效'); }
  if (dnsMode === 'existing' && (visibility !== 'public' || !accountId)) { throw new Error('保留现有 DNS 需要选择公网访问与 DNS 账号'); }
  if (typeof note !== 'string' || note.length > 300) { throw new Error('备注长度超过限制'); }
  return {alias, host, port: Number(port), scheme, visibility, dnsMode, note, ...(domain ? {domain} : {}), ...(deviceId ? {deviceId} : {}), ...(accountId ? {accountId} : {}), authorizedBy: visibility === 'public' ? 'console-admin' : undefined};
}

export function serviceRegistry(settings: PortalSettings, socket: string) {
  let active = false;
  const root = settings.portal.root;
  const devices = deviceDirectory(root);
  const credentials = accounts(root);
  const tls = certificates(root);
  let nextRenewal = 0;
  const publishedFile = `${root}/published.json`;
  const statusFile = `${root}/last-apply.json`;
  const previous = (): Alias[] => existsSync(publishedFile) ? JSON.parse(readFileSync(publishedFile, 'utf8')) : [];
  const assertIdle = () => { if (active) { throw new Error('配置正在发布，请稍后再试'); } };
  async function resolve(item: Alias): Promise<Alias> {
    if (!item.deviceId) { return item; }
    const address = await devices.resolve(item.deviceId);
    // 留空表示设备本机；显式目标表示已通过 EasyTier 子网路由到达的服务。
    if (['127.0.0.1', 'localhost'].includes(item.host)) { throw new Error('设备服务留空目标主机即可，不能把远端 loopback 当作入口本机'); }
    return {...item, host: item.host || address};
  }
  return {
    devices, accounts: credentials, assertIdle,
    status: () => existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : null,
    list: () => readAliases(settings),
    save: (value: Record<string, unknown>) => {
      assertIdle();
      const old = readAliases(settings).find(item => item.alias === value.alias);
      const entry = validate({...value, dnsMode: value.dnsMode ?? old?.dnsMode});
      const name = serviceDomain(settings, entry);
      if ([new URL(process.env.TUNNEL_PUBLIC_URL ?? 'http://localhost').hostname, process.env.TUNNEL_RAW_HOST].includes(name)) { throw new Error('控制台与灰云入口不能被服务覆盖'); }
      if (entry.accountId && credentials.get(entry.accountId).domain !== (entry.domain || settings.suffix)) { throw new Error('域名后缀与 DNS 账号不匹配'); }
      if (old?.dnsMode === 'existing' && entry.visibility !== 'public') { throw new Error('请先关闭原公网入口，再删除此登记并按仅内网重新添加'); }
      if (old && (old.domain !== entry.domain || old.accountId !== entry.accountId)) { throw new Error('迁移域名或 DNS 账号前请先删除旧服务并应用'); }
      return upsert(settings, entry);
    },
    remove: (alias: string) => { assertIdle(); return remove(settings, alias); },
    async recover() {
      if (active || !existsSync(publishedFile)) { return; }
      active = true;
      try {
        const ids = new Set((await devices.list()).map(device => device.id));
        // 撤销配对后撤掉路由；网络暂时离线不销毁登记。
        const aliases = previous().filter(item => !item.deviceId || ids.has(item.deviceId));
        await publish(settings, aliases, socket, tls.list(aliases.map(item => serviceDomain(settings, item))));
        if (Date.now() >= nextRenewal) {
          nextRenewal = Date.now() + 12 * 3600_000;
          for (const item of aliases) {
            if (item.accountId && process.env.TUNNEL_ACME_DIRECTORY) { await tls.ensure(credentials.get(item.accountId), serviceDomain(settings, item)); }
          }
        }
        await publish(settings, aliases, socket, tls.list(aliases.map(item => serviceDomain(settings, item))));
      } finally { active = false; }
    },
    async apply() {
      assertIdle(); active = true;
      const steps: Array<{step: string; state: string; detail?: string}> = [];
      function record(step: string, state: string, detail?: string) {
        steps.push({step, state, ...(detail ? {detail} : {})});
        writeFileSync(statusFile, JSON.stringify({at: Date.now(), state: state === 'failed' ? 'failed' : 'running', steps}), {mode: 0o600});
      }
      try {
        record('准备发布', 'running');
        const aliases = await Promise.all(readAliases(settings).map(resolve));
        if (process.env.TUNNEL_VERIFY_UPSTREAM === '1') { await Promise.all(aliases.map(item => probe(item.host, item.port))); }
        record('设备与目标端口', 'success');
        const removed = previous().filter(old => !aliases.some(item => item.alias === old.alias));
        const plans: Array<() => Promise<void>> = [];
        for (const item of [...aliases, ...removed.filter(item => item.dnsMode !== 'existing').map(item => ({...item, visibility: 'internal' as const}))]) {
          if (item.accountId) {
            const plan = await dnsPlan(credentials.get(item.accountId), serviceDomain(settings, item), item.visibility!, item.dnsMode);
            plans.push(() => plan.apply());
          } else if (item.visibility === 'public') {
            if (item.domain && item.domain !== settings.suffix) { throw new Error('请选择该域名的 DNS 账号'); }
            const provider = dnsProvider(settings, item);
            const plan = await provider.plan(item, settings);
            if (plan.blocked) { throw new Error(plan.warnings.join('; ')); }
            plans.push(async () => {
              await provider.apply(item, settings, plan);
              if (!(await provider.verify(item, settings)).ok) { throw new Error(`${item.alias}: DNS 读回校验失败`); }
            });
          }
        }
        record('DNS 预检', 'success');
        // 先收紧代理策略，再进行 DNS 变更，公网转内网时立即拒绝外部请求。
        const domains = aliases.map(item => serviceDomain(settings, item));
        await publish(settings, aliases, socket, tls.list(domains));
        writeFileSync(publishedFile, JSON.stringify(aliases), {mode: 0o600});
        record('Caddy 路由与访问范围', 'success');
        for (const plan of plans) { await plan(); }
        record('云 DNS 校验与应用', 'success');
        if (process.env.TUNNEL_ACME_DIRECTORY) {
          record('HTTPS 证书签发', 'running');
          for (const item of aliases) {
            if (item.accountId) { await tls.ensure(credentials.get(item.accountId), serviceDomain(settings, item)); }
          }
          await publish(settings, aliases, socket, tls.list(domains));
          record('HTTPS 证书安装', 'success');
        }
        mkdirSync(`${root}/dns`, {recursive: true});
        const hosts = aliases.map(item => `${settings.lanIp} ${serviceDomain(settings, item)}`).join('\n');
        writeFileSync(`${root}/dns/tunnel.hosts`, `${hosts}\n`, {mode: 0o644});
        record('内网 DNS 文件', 'success');
        const report = {at: Date.now(), state: 'success', routes: aliases.map(item => item.alias), steps, dns: '内网解析由主机监听器加载'};
        writeFileSync(statusFile, JSON.stringify(report), {mode: 0o600});
        return report;
      } catch (error) {
        record('发布', 'failed', error instanceof Error ? error.message : '配置发布失败');
        throw error;
      } finally { active = false; }
    },
  };
}
