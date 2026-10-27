/**
 * 把 tunnel 控制台的服务登记同步成 182 内网入口（aio-portal）。
 *
 * 为什么需要：局域网浏览器解析 *.lyokm.cn 走的是 182 的 localmesh + dnsmasq，
 * 而那份期望态由 aio-portal 的注册表决定；tunnel 控制台只管公网 DNS 与自己的 Caddy。
 * 两套都是"入口"，但读的不是同一份表 —— 于是同一个域名要在两处各登记一次。
 * 这个脚本把 tunnel 的已登记服务作为上游事实，单向补齐 182 侧：
 *
 *   tunnel /api/services  ->  aio-portal aliases.json（只写 tunnel 负责的那些别名）
 *                         ->  aio-plugin-portal sync --apply（dnsmasq + localmesh Caddy）
 *
 * 只增改 tunnel 名下（同名别名）的条目，不动 fire/hifly/nacos 等 182 本机自有站点；
 * tunnel 侧删除的别名也不会在这里被删（内网入口比公网更宽松，避免误删）。
 *
 * 用法：
 *   TUNNEL_API_TOKEN=... node scripts/sync-lan-edge.mjs [--dry-run]
 */
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const DEFAULT_HOME = '/root/DockerCompose/aio-portal';
const DEFAULT_API = 'http://127.0.0.1:3180';

/**
 * 纯计算：控制台服务列表 + 现有内网注册表 -> 目标条目、差异、跳过原因。
 * 不读文件、不写文件，便于单测。
 */
export function planSync({services, devices, suffix, aliases}) {
  const address = new Map(devices.map(item => [item.id, item.address]));
  const desired = new Map();
  const skipped = [];
  for (const item of services) {
    // TCP 入口（pg/mysql/redis）走的是端口映射，不是 HTTP 站点，内网侧由 aio-portal 自己维护。
    if (item.scheme === 'tcp' || item.readOnly) { continue; }
    if ((item.domain ?? suffix) !== suffix) { skipped.push(`${item.alias}（${item.domain}）`); continue; }
    let host = item.host || address.get(item.deviceId);
    // 182 自己就是 10.144.144.1：回环比自连 tun0 少一跳，也和已有登记保持一致。
    if (host === '10.144.144.1') { host = '127.0.0.1'; }
    if (!host) { skipped.push(`${item.alias}（设备未绑定 EasyTier 地址）`); continue; }
    desired.set(item.alias, {
      alias: item.alias,
      host,
      port: item.port,
      scheme: item.scheme ?? 'http',
      // 182 侧一律按"仅内网"呈现：公网是否可达由 tunnel 的公网 DNS + 证书决定，不经 182。
      visibility: 'internal',
      lan: true,
      note: item.note ?? '',
      stream: true,
      disabled: false,
    });
  }

  const existing = new Map(aliases.map(item => [item.alias, item]));
  const changes = [];
  for (const [alias, want] of desired) {
    const current = existing.get(alias);
    if (!current) { changes.push({alias, kind: '新增', want}); continue; }
    const same = current.host === want.host
      && Number(current.port) === Number(want.port)
      && (current.scheme ?? 'http') === want.scheme
      && (current.visibility ?? 'internal') === 'internal'
      && current.disabled !== true;
    if (!same) { changes.push({alias, kind: '更新', want, current}); }
  }
  return {desired, existing, changes, skipped};
}

/** 把差异合并进注册表条目（只覆盖 tunnel 自己的字段，保留其他来源写入的字段）。 */
export function mergeChanges(existing, changes) {
  const next = new Map(existing);
  for (const change of changes) {
    next.set(change.alias, {...(next.get(change.alias) ?? {}), ...change.want});
  }
  return [...next.values()].sort((left, right) => left.alias.localeCompare(right.alias));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const api = process.env.TUNNEL_API ?? DEFAULT_API;
  const token = process.env.TUNNEL_API_TOKEN;
  const home = process.env.AIO_PORTAL_HOME ?? DEFAULT_HOME;
  const cli = process.env.AIO_PORTAL_CLI ?? '/opt/cloud-dev/zjarlin/aio/workspace/zjarlin/aio/aio-plugin-portal/dist/cli.mjs';
  const registry = `${home}/aliases.json`;
  if (!token) { console.error('缺少 TUNNEL_API_TOKEN'); process.exit(2); }
  if (!existsSync(registry)) { console.error(`注册表不存在：${registry}`); process.exit(2); }

  const get = async path => {
    const response = await fetch(`${api}${path}`, {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(20_000)});
    if (!response.ok) { throw new Error(`${path} -> HTTP ${response.status}`); }
    return response.json();
  };

  const [services, devices] = await Promise.all([get('/api/services'), get('/api/devices')]);
  const suffix = JSON.parse(readFileSync(`${home}/aio-portal.json`, 'utf8')).suffix;
  const registryData = JSON.parse(readFileSync(registry, 'utf8'));
  const {desired, existing, changes, skipped} = planSync({
    services: services.items,
    devices: devices.items,
    suffix,
    aliases: registryData.aliases ?? [],
  });

  for (const change of changes) {
    const before = change.kind === '更新' ? `（原 ${change.current.host}:${change.current.port}）` : '';
    console.log(`${change.kind} ${change.alias} -> ${change.want.host}:${change.want.port}${before}`);
  }
  if (skipped.length) { console.log(`跳过非 ${suffix} 域名或未就绪的登记：${skipped.join('、')}`); }
  if (!changes.length) { console.log(`内网入口已同步（${desired.size} 条 tunnel 服务，0 处差异）`); return; }
  if (dryRun) { console.log(`dry-run：共 ${changes.length} 处需要同步，未写入`); return; }

  const next = {aliases: mergeChanges(existing, changes)};
  writeFileSync(`${registry}.tmp`, `${JSON.stringify(next, null, 2)}\n`, {mode: 0o600});
  renameSync(`${registry}.tmp`, registry);

  // 只调一次 sync：dnsmasq 的 reload 不会加载新增片段，每条都重启会撞 systemd start-limit。
  const result = spawnSync(process.execPath, [cli, 'sync', '--apply', '--home', home], {encoding: 'utf8', timeout: 180_000});
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) { console.error(`aio-portal sync 失败（exit ${result.status}）`); process.exit(1); }
  console.log(`已同步 ${changes.length} 处到 182 内网入口`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
