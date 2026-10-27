/** 别名注册表：数据库是唯一真相源，内存缓存让发布路径保持同步读。 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Alias, PortalSettings, Registry} from '../config/index.js';
import {loadRegistry, registryFile} from '../config/index.js';
import {deleteRow, driver, listRows, writeRow} from './store.js';

const sort = (items: Alias[]) => items.slice().sort((a, b) => a.alias.localeCompare(b.alias));

let cache: Alias[] | null = null;
let cacheDriver: ReturnType<typeof driver> | undefined;
let cacheSource = '';

export const source = (): string => cacheSource || '（尚未加载）';
export const driverOf = (): ReturnType<typeof driver> => cacheDriver ?? driver();

/** 读一次注册表进缓存；命令与 HTTP 请求开头调用。 */
export async function hydrate(settings: PortalSettings): Promise<Alias[]> {
  cacheDriver = driver();
  if (cacheDriver === 'file') {
    cacheSource = `file:${registryFile(settings)}`;
    cache = loadRegistry(settings).aliases;
  } else {
    cacheSource = 'database:portal.service';
    cache = await listRows(settings);
  }
  return sort(cache);
}

function loaded(): Alias[] {
  if (!cache) throw new Error('注册表尚未加载：调用方必须先 await hydrate(settings)');
  return cache;
}

export function writeRegistry(s: PortalSettings, registry: Registry): void {
  const file = registryFile(s);
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, {mode: 0o600});
  renameSync(tmp, file);
}

/** 快照：数据库驱动下是序列化后的记录，文件驱动下是原文。 */
export function snapshot(s: PortalSettings): string | null {
  if (cacheDriver === 'file') {
    const file = registryFile(s);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  return cache ? JSON.stringify(sort(cache)) : null;
}

export async function upsert(s: PortalSettings, entry: Alias, by = 'tunnel'): Promise<Registry> {
  const next = sort(loaded().filter(item => item.alias !== entry.alias).concat(entry));
  if (cacheDriver === 'file') writeRegistry(s, {aliases: next});
  else await writeRow(entry, by);
  cache = next;
  return {aliases: next};
}

export async function remove(s: PortalSettings, alias: string): Promise<{registry: Registry; removed?: Alias}> {
  const removed = loaded().find(item => item.alias === alias);
  const next = sort(loaded().filter(item => item.alias !== alias));
  if (cacheDriver === 'file') writeRegistry(s, {aliases: next});
  else await deleteRow(alias);
  cache = next;
  return {registry: {aliases: next}, removed};
}

export const aliasFqdn = (s: PortalSettings, alias: string): string => `${alias}.${s.suffix}`;

export function readAliases(_s: PortalSettings): Alias[] {
  return sort(loaded());
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
