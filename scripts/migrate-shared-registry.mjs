/**
 * 把 182 内网登记表（aio-portal）与控制台登记表（tunnel）合并成一份。
 *
 * 收敛后的模型：只有一份注册表，每条登记用 `edges` 声明由哪些入口渲染
 *   - localmesh ：182 的 localmesh Caddy + dnsmasq（aio-portal sync）
 *   - home-edge ：tunnel 控制台发布的外部入口
 * 两个入口读同一份文件，各自只渲染自己那一份，不再各存一份别名。
 *
 * 迁移规则（幂等：已经带 `edges` 的条目不改动）：
 *   1. 只在一侧出现：归属那一侧的入口；从 tunnel 迁进内网表的条目补 `suffix`。
 *   2. 两侧都有且内网表里是停用状态：只归 home-edge
 *      （内网侧主动停用通常意味着该站点已由 localmesh 人工站点托管，例如 s3/tc）。
 *   3. 两侧都有且内网表启用：两个入口都渲染，`stream` 等内网字段并入共享条目。
 *
 * 用法：node scripts/migrate-shared-registry.mjs [--apply] [--suffix lyokm.cn]
 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const portalFile = flag('portal', '/root/DockerCompose/aio-portal/aliases.json');
const tunnelFile = flag('tunnel', '/root/DockerCompose/tunnel/data/aliases.json');
const suffix = flag('suffix', 'lyokm.cn');
const mirrorFile = flag('mirror', '');
const apply = args.includes('--apply');

const read = file => {
  if (!existsSync(file)) { throw new Error(`注册表不存在：${file}`); }
  return JSON.parse(readFileSync(file, 'utf8'));
};

/** 纯函数：两侧登记 -> 合并后的条目与提要，便于审阅与单测。 */
export function mergeRegistries({portal, tunnel, suffix}) {
  const portalEntries = new Map((portal.aliases ?? []).map(item => [item.alias, item]));
  const tunnelEntries = new Map((tunnel.aliases ?? []).map(item => [item.alias, item]));
  const summary = {shared: [], localOnly: [], edgeOnly: [], kept: []};
  const merged = new Map();

  for (const [alias, tunnelEntry] of tunnelEntries) {
    const portalEntry = portalEntries.get(alias);
    if (tunnelEntry.edges?.length) { merged.set(alias, tunnelEntry); summary.kept.push(alias); continue; }
    if (!portalEntry) {
      merged.set(alias, {...tunnelEntry, edges: ['home-edge']});
      summary.edgeOnly.push(alias);
      continue;
    }
    if (portalEntry.disabled === true) {
      // 内网侧主动停用：站点改由 localmesh 人工文件托管，只剩外部入口需要发布。
      merged.set(alias, {...tunnelEntry, edges: ['home-edge']});
      summary.shared.push(`${alias}（内网侧停用，只归 home-edge）`);
      continue;
    }
    merged.set(alias, {
      ...tunnelEntry,
      edges: ['localmesh', 'home-edge'],
      ...(portalEntry.stream ? {stream: true} : {}),
      ...(portalEntry.tls ? {tls: portalEntry.tls} : {}),
    });
    summary.shared.push(alias);
  }

  for (const [alias, portalEntry] of portalEntries) {
    if (tunnelEntries.has(alias)) { continue; }
    merged.set(alias, {
      // 先放内网字段，再补控制台需要的语义字段（domain/edges/suffix）。
      ...portalEntry,
      suffix: portalEntry.suffix ?? suffix,
      domain: portalEntry.domain ?? portalEntry.suffix ?? suffix,
      edges: portalEntry.edges?.length ? portalEntry.edges : ['localmesh'],
    });
    summary.localOnly.push(alias);
  }

  const aliases = [...merged.values()].sort((left, right) => left.alias.localeCompare(right.alias));
  return {aliases, summary};
}

const main = () => {
  const portal = read(portalFile);
  const tunnel = read(tunnelFile);
  const {aliases, summary} = mergeRegistries({portal, tunnel, suffix});
  console.log(`内网表 ${(portal.aliases ?? []).length} 条 / 控制台表 ${(tunnel.aliases ?? []).length} 条 -> 合并 ${aliases.length} 条`);
  console.log(`  两侧都有 ${summary.shared.length}、只在内网 ${summary.localOnly.length}、只在控制台 ${summary.edgeOnly.length}、已带归属跳过 ${summary.kept.length}`);
  for (const alias of summary.localOnly) { console.log(`  只在内网：${alias} -> 补进共享表（edges=localmesh）`); }
  if (!apply) {
    console.log('（预览模式；加 --apply 写入）');
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  const backupDir = join(dirname(portalFile), 'backup');
  mkdirSync(backupDir, {recursive: true, mode: 0o700});
  for (const [file, label] of [[portalFile, 'portal'], [tunnelFile, 'tunnel']]) {
    const target = join(backupDir, `aliases.json.before-shared-registry-${stamp}-${label}`);
    writeFileSync(target, readFileSync(file), {mode: 0o600});
    console.log(`备份 ${file} -> ${target}`);
  }
  const write = file => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({aliases}, null, 2)}\n`, {mode: 0o600});
    renameSync(tmp, file);
  };
  write(portalFile);
  // 切换期间控制台容器还读旧路径：先镜像一份，避免切换窗口内读到"空注册表"。
  if (mirrorFile) { write(mirrorFile); console.log(`已镜像到 ${mirrorFile}（切换后改名留档）`); }
  // 控制台旧表不再被读取（TUNNEL_REGISTRY_FILE 指向共享表），改名留档避免两份并存。
  const retired = join(dirname(tunnelFile), `aliases.json.retired-${stamp}`);
  renameSync(tunnelFile, retired);
  console.log(`已写入 ${portalFile}；控制台旧表改名留档 -> ${retired}`);
};

if (import.meta.url === `file://${process.argv[1]}`) { main(); }
