import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {rendersOn, serviceSuffix, type Alias, type Edge, type PortalSettings} from '../config/index.js';
import {hydrate, readAliases, upsert, remove} from '../portal/registry.js';
import {dnsProvider} from '../portal/providers.js';
import {publish, serviceDomain} from './caddy.js';
import {deviceDirectory, probe, validHost} from './devices.js';
import {accounts} from './accounts.js';
import {dnsPlan} from './cloud-dns.js';
import {certificates} from './certificates.js';
import {verifyPrivateFrpListener} from './frp.js';
import {tcpCatalog} from './tcp-catalog.js';
import {resolveHost} from './targets.js';

/**
 * 注册表是唯一真相源，别的入口（aio-portal / 数据迁移脚本）写进来的字段
 * 不能在控制台保存时被抹掉：这里只接管表单字段，其余原样保留。
 */
const PRESERVED = ['edges', 'stream', 'disabled', 'tls'] as const;

function preservedFields(value: Record<string, unknown>, old?: Alias): Partial<Alias> {
  const out: Partial<Alias> = {};
  for (const key of PRESERVED) {
    const next = key in value ? value[key] : old?.[key];
    if (next !== undefined) { (out as Record<string, unknown>)[key] = next; }
  }
  if (out.edges) {
    const edges = [...new Set(out.edges.filter((edge): edge is Edge => edge === 'localmesh' || edge === 'home-edge'))];
    if (!edges.length) { throw new Error('入口归属只能是 localmesh 或 home-edge'); }
    out.edges = edges;
  }
  return out;
}

export function validate(value: Record<string, unknown>): Alias {
  const {alias, port, scheme, visibility, note} = value;
  const host = String(value.host || '');
  const deviceId = String(value.deviceId || '');
  const accountId = String(value.accountId || '');
  // `suffix` 与 `domain` 同义，收敛后统一按 `suffix` 落盘，`domain` 继续镜像给控制台用。
  const domain = String(value.suffix ?? value.domain ?? '');
  const dnsMode = value.dnsMode ?? 'managed';
  const transport = value.transport ?? 'easytier';
  const tlsServerName = String(value.tlsServerName ?? '');
  if (transport !== 'easytier' && transport !== 'frp') { throw new Error('连接方式无效'); }
  if (transport === 'frp' && !validHost(host)) { throw new Error('请填写 FRP 映射地址，不能留空使用设备的中继地址'); }
  if (transport === 'frp' && visibility === 'internal' && host !== '127.0.0.1') { throw new Error('仅内网 FRP 映射必须使用入口本机 127.0.0.1'); }
  if (typeof alias !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias)) { throw new Error('域名别名无效'); }
  if ((!deviceId || host) && !validHost(host)) { throw new Error('目标主机无效'); }
  if (domain && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) { throw new Error('域名后缀无效'); }
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) { throw new Error('端口必须在 1～65535 之间'); }
  if (scheme !== 'http' && scheme !== 'https') { throw new Error('协议无效'); }
  if (tlsServerName && (scheme !== 'https' || !validHost(tlsServerName))) { throw new Error('上游 TLS 主机名无效'); }
  if (transport === 'frp' && scheme === 'https' && !tlsServerName) { throw new Error('HTTPS FRP 映射需要填写上游证书的 TLS 主机名'); }
  if (visibility !== 'internal' && visibility !== 'public') { throw new Error('访问范围无效'); }
  if (dnsMode !== 'managed' && dnsMode !== 'existing') { throw new Error('DNS 方式无效'); }
  if (dnsMode === 'existing' && (visibility !== 'public' || !accountId)) { throw new Error('保留现有 DNS 需要选择公网访问与 DNS 账号'); }
  if (typeof note !== 'string' || note.length > 300) { throw new Error('备注长度超过限制'); }
  return {alias, host, port: Number(port), scheme, visibility, dnsMode, transport, note, ...(tlsServerName ? {tlsServerName} : {}), ...(domain ? {suffix: domain, domain} : {}), ...(deviceId ? {deviceId} : {}), ...(accountId ? {accountId} : {}), authorizedBy: visibility === 'public' ? 'console-admin' : undefined};
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
  const tcp = () => tcpCatalog(process.env.TUNNEL_TCP_CATALOG);
  const assertHttp = (alias: unknown) => {
    if (tcp().some(item => item.alias === alias)) { throw new Error('此 TCP 入口由现有内网代理管理，不能在 HTTP 表单中修改或删除'); }
  };
  async function resolve(item: Alias): Promise<Alias> {
    if (item.transport === 'frp') {
      if (item.deviceId && !(await devices.list()).some(device => device.id === item.deviceId)) { throw new Error('设备未配对或已撤销'); }
      verifyPrivateFrpListener(item);
      await probe(item.host, item.port);
      return item;
    }
    if (!item.deviceId) { return item; }
    const outlet = devices.publish();
    const address = await devices.resolve(item.deviceId);
    return {...item, host: resolveHost(item, outlet?.id, address)};
  }
  return {
    devices, accounts: credentials, assertIdle,
    status: () => existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : null,
    async list() {
      await hydrate(settings);
      const aliases = readAliases(settings);
      const endpoints = tcp();
      if (aliases.some(item => endpoints.some(endpoint => endpoint.alias === item.alias))) { throw new Error('HTTP 与 TCP 服务别名冲突，请检查入口配置'); }
      return [...aliases, ...endpoints].sort((a, b) => a.alias.localeCompare(b.alias));
    },
    async save(value: Record<string, unknown>) {
      assertIdle();
      await hydrate(settings);
      assertHttp(value.alias);
      const old = readAliases(settings).find(item => item.alias === value.alias);
      // 表单只提交自己管的字段：域名后缀没改时沿用登记里的值，不能因为没带就退回全局后缀。
      const entry = validate({...value, suffix: value.suffix ?? value.domain ?? old?.suffix ?? old?.domain, dnsMode: value.dnsMode ?? old?.dnsMode, transport: value.transport ?? old?.transport, tlsServerName: value.scheme === 'https' ? value.tlsServerName ?? old?.tlsServerName : ''});
      const name = serviceDomain(settings, entry);
      if ([new URL(process.env.TUNNEL_PUBLIC_URL ?? 'http://localhost').hostname, process.env.TUNNEL_RAW_HOST].includes(name)) { throw new Error('控制台与灰云入口不能被服务覆盖'); }
      if (entry.accountId && credentials.get(entry.accountId).domain !== serviceSuffix(settings, entry)) { throw new Error('域名后缀与 DNS 账号不匹配'); }
      if (old?.dnsMode === 'existing' && entry.visibility !== 'public') { throw new Error('请先关闭原公网入口，再删除此登记并按仅内网重新添加'); }
      if (old && (serviceSuffix(settings, old) !== serviceSuffix(settings, entry) || old.accountId !== entry.accountId)) { throw new Error('迁移域名或 DNS 账号前请先删除旧服务并应用'); }
      return upsert(settings, {...entry, ...preservedFields(value, old)});
    },
    async remove(alias: string) {
      assertIdle(); assertHttp(alias);
      await hydrate(settings);
      return remove(settings, alias);
    },
    async recover() {
      if (active || !existsSync(publishedFile)) { return; }
      active = true;
      try {
        const ids = new Set((await devices.list()).map(device => device.id));
        // 撤销配对后撤掉路由；网络暂时离线不销毁登记。
        let failure: Error | undefined;
        const aliases = previous().filter(item => {
          if (!rendersOn(item, 'home-edge')) { return false; }
          if (item.deviceId && !ids.has(item.deviceId)) { return false; }
          try { verifyPrivateFrpListener(item); return true; }
          catch (error) { failure = error as Error; return false; }
        });
        await publish(settings, aliases, socket, tls.list(aliases.map(item => serviceDomain(settings, item))));
        if (failure) { throw failure; }
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
        // 上一步还停在「发布中」说明它已经做完：进入下一步时收口，发布记录不出现悬空的进度。
        for (const item of steps) { if (item.state === 'running') { item.state = 'success'; } }
        steps.push({step, state, ...(detail ? {detail} : {})});
        writeFileSync(statusFile, JSON.stringify({at: Date.now(), state: state === 'failed' ? 'failed' : 'running', steps}), {mode: 0o600});
      }
      try {
        await hydrate(settings);
        // 发布出口必须是可以出网的那台；没指定时明确报出来，而不是默默用本机。
        const outlet = devices.publish();
        const outletLabel = outlet ? (await devices.list()).find(item => item.id === outlet.id)?.label ?? outlet.id : undefined;
        record('准备发布', 'running', outletLabel ? `发布出口 ${outletLabel}` : '未指定发布节点，按本机出口发布');
        // 注册表里同时有 182 内网（localmesh）与外部入口的登记，本服务只发布自己的那部分。
        const aliases = await Promise.all(readAliases(settings).filter(item => rendersOn(item, 'home-edge')).map(resolve));
        // 上游探测是「发现问题」而不是「拦住发布」：单台后端离线不该让其余路由一起停摆。
        // 不可达的条目照常生成路由（访问时返回 502），但要在发布记录里点名，便于排查。
        let unreachable: string[] = [];
        if (process.env.TUNNEL_VERIFY_UPSTREAM === '1') {
          const probes = await Promise.all(aliases.map(async item => {
            try { await probe(item.host, item.port); return ''; }
            catch { return `${item.alias}（${item.host}:${item.port}）`; }
          }));
          unreachable = probes.filter(Boolean);
        }
        record('设备与目标端口', 'success', unreachable.length ? `上游暂不可达：${unreachable.join('、')}` : undefined);
        const removed = previous().filter(old => !aliases.some(item => item.alias === old.alias));
        const plans: Array<() => Promise<void>> = [];
        for (const item of [...aliases, ...removed.filter(item => item.dnsMode !== 'existing').map(item => ({...item, visibility: 'internal' as const}))]) {
          if (item.accountId) {
            const plan = await dnsPlan(credentials.get(item.accountId), serviceDomain(settings, item), item.visibility!, item.dnsMode);
            plans.push(() => plan.apply());
          } else if (item.visibility === 'public') {
            if (serviceSuffix(settings, item) !== settings.suffix) { throw new Error('请选择该域名的 DNS 账号'); }
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
        const report = {at: Date.now(), state: 'success', routes: aliases.map(item => item.alias), ...(unreachable.length ? {warnings: unreachable} : {}), steps, dns: '内网解析由主机监听器加载'};
        writeFileSync(statusFile, JSON.stringify(report), {mode: 0o600});
        return report;
      } catch (error) {
        record('发布', 'failed', error instanceof Error ? error.message : '配置发布失败');
        throw error;
      } finally { active = false; }
    },
  };
}
