/** 门户子命令实现：登记、同步、校验、体检、网关窗口。 */
import {existsSync} from 'node:fs';
import type {Alias, PortalSettings} from '../config/index.js';
import {loadSettings} from '../config/index.js';
import {gatewayAdapter} from './gateway.js';
import {aliasFqdn, hydrate, readAliases, remove, snapshot, source, upsert} from './registry.js';
import {render, reloadResolver, validateCaddy, reloadCaddy} from './render.js';
import {reconcile, formatReport} from './reconcile.js';

const isAlias = (value: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const isHost = (value: string) => /^[A-Za-z0-9_.:-]+$/.test(value);
const parsePort = (value: string) => {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`端口不合法：${value}`);
  return port;
};

const settings = (home?: string) => loadSettings(home);

export async function add(options: {alias: string; host: string; port: string; scheme: string; note?: string; visibility: 'internal' | 'public'; authorizedBy?: string; home?: string}): Promise<string> {
  const s = settings(options.home);
  await hydrate(s);
  if (!isAlias(options.alias)) throw new Error('别名只能使用小写字母、数字和连字符');
  if (!isHost(options.host)) throw new Error('目标主机不合法');
  if (options.scheme !== 'http' && options.scheme !== 'https') throw new Error('协议只能是 http 或 https');
  if (options.visibility === 'public' && !options.authorizedBy) throw new Error('public 别名必须提供 --authorized-by，明确记录授权人');
  const entry: Alias = {
    alias: options.alias,
    host: options.host,
    port: parsePort(options.port),
    scheme: options.scheme,
    visibility: options.visibility,
    lan: options.visibility === 'internal' && s.mode !== 'none',
    authorizedBy: options.authorizedBy,
    note: options.note ?? '',
  };
  await upsert(s, entry, 'cli');
  const result = render(s);
  return [
    `已登记 ${aliasFqdn(s, entry.alias)} -> ${entry.scheme}://${entry.host}:${entry.port}（${entry.visibility}，共 ${result.aliases} 条）`,
    renderReload(s),
  ].join('\n');
}

export async function removeAlias(options: {alias: string; home?: string}): Promise<string> {
  const s = settings(options.home);
  await hydrate(s);
  const result = await remove(s, options.alias);
  if (!result.removed) throw new Error(`未找到别名：${options.alias}`);
  const rendered = render(s);
  return [`已删除 ${aliasFqdn(s, options.alias)}（剩余 ${rendered.aliases} 条）`, renderReload(s)].join('\n');
}

export async function list(options: {home?: string}): Promise<string> {
  const s = settings(options.home);
  const aliases = await hydrate(s);
  if (!aliases.length) return '（空）';
  return aliases
    .map(item => `  ${aliasFqdn(s, item.alias).padEnd(30)} -> ${item.scheme}://${item.host}:${item.port}  ${item.visibility ?? 'internal'}  ${item.note ?? ''}`)
    .join('\n');
}

export async function sync(options: {home?: string; apply?: boolean}): Promise<string> {
  const s = settings(options.home);
  await hydrate(s);
  const before = snapshot(s);
  const result = render(s);
  const report = await reconcile(s, {apply: options.apply});
  const after = snapshot(s);
  if (before !== after) throw new Error('同步过程中注册表被其它进程修改，请重试');
  const lines = [
    `已生成 ${result.aliases} 条映射与 ${result.caddy.length} 个 Caddy 站点`,
    renderReload(s),
    validateCaddy(s),
    reloadCaddy(s),
    formatReport(report),
  ];
  if (!report.ok) {
    throw new Error(`${lines.join('\n')}\n同步被拒绝：存在未满足的 provider 计划或校验，未发布任何变更`);
  }
  return lines.join('\n');
}

export async function plan(options: {home?: string}): Promise<string> {
  const s = settings(options.home);
  await hydrate(s);
  return formatReport(await reconcile(s, {apply: false}));
}

function renderReload(s: PortalSettings): string {
  if (!s.portal.reload) return '已跳过服务热加载（portal.reload=false）';
  return reloadResolver(s);
}

export async function doctor(options: {home?: string}): Promise<string> {
  const s = settings(options.home);
  await hydrate(s);
  const resolved = existsSync(s.resolver.configFile!);
  const rendered = existsSync(`${s.portal.aliasesDir}/${s.portal.mapPrefix}.map`);
  const lines = [
    `  域名后缀        ${s.suffix}`,
    `  解析模式        ${s.mode}`,
    `  内网 IP         ${s.lanIp || '（未配置）'}`,
    `  注册表          ${readAliases(s).length} 条（${source()}）`,
    `  映射片段        ${rendered ? '已生成' : '缺失'}`,
    `  解析配置        ${resolved ? '已生成' : '缺失'}`,
    `  Caddy provider  ${s.providers?.connectivity ?? 'caddy'}  sites=${s.caddy?.sitesDir ?? '（未配置）'}  bind=${s.caddy?.bind ?? '（未配置）'}`,
    `  网关适配器      ${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : '（未配置地址）'}`,
  ];
  const internal = readAliases(s).filter(item => (item.visibility ?? 'internal') === 'internal');
  const guard = internal.every(item => Boolean(s.caddy?.bind) && Boolean(s.caddy?.allow?.length));
  if (!guard) lines.push('  内网防护        internal 别名缺少 caddy.bind 或 caddy.allow');
  const ok = rendered && resolved && Boolean(s.suffix) && Boolean(s.lanIp || s.mode !== 'lan') && guard;
  return [...lines, ok ? '体检通过' : '存在缺失项，请先执行 sync 或补齐配置'].join('\n');
}

export async function warden(options: {password?: string; apply?: boolean; restore?: boolean; home?: string}): Promise<string> {
  const s = settings(options.home);
  const target = s.lanIp || '本机内网 IP';
  if (!options.password) {
    return [
      '网关窗口：把网关上游 DNS 指向本机解析器，让局域网所有设备自动走内网。',
      `  网关适配器：${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : '（未配置 address）'}`,
      `  DNS1 目标：${target}     DNS2 兜底：${s.gateway.fallbackDns}`,
      '',
      '  aio-plugin-portal warden --password <网关密码>            # 只读探测',
      '  aio-plugin-portal warden --password <网关密码> --apply    # 写入',
      '  aio-plugin-portal warden --password <网关密码> --restore  # 回滚',
      '',
      '手动等价操作：网关管理页 → 上网设置 → DNS1 填本机 IP、DNS2 填公网解析器。',
    ].join('\n');
  }
  const adapter = gatewayAdapter(s.gateway, options.password);
  if (options.restore) {
    await adapter.restore();
    return '已恢复网关上游 DNS 为自动获取。';
  }
  const probe = await adapter.probe();
  const head = `网关适配器 ${probe.adapter}：当前 ${probe.wanType ?? '-'}，DNS ${probe.current.dns1 || '自动'} / ${probe.current.dns2 || '自动'}`;
  if (!options.apply) return [head, '只读探测完成，未做修改。确认后加 --apply 写入。'].join('\n');
  if (!s.lanIp) throw new Error('未配置内网 IP（lanIp），无法写入网关');
  await adapter.apply({dns1: s.lanIp, dns2: s.gateway.fallbackDns ?? '223.5.5.5'});
  return [head, `已把网关上游 DNS 设为 ${s.lanIp}（兜底 ${s.gateway.fallbackDns}）。局域网设备无需任何设置即自动走内网。`].join('\n');
}
