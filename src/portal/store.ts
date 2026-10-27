/**
 * 注册表存储：与 182 内网入口（aio-portal）共用一张表 `portal.service`，
 * 数据库是唯一真相源；JSON 只在本地开发/CI 且没配连接串时使用。
 */
import {existsSync, readFileSync} from 'node:fs';
import type {Alias, PortalSettings} from '../config/index.js';
import {loadRegistry, normalizeAlias} from '../config/index.js';

const TABLE = 'portal.service';

export function databaseUrl(): string | undefined {
  return process.env.TUNNEL_REGISTRY_DATABASE_URL || process.env.TUNNEL_AIO_DATABASE_URL || undefined;
}

export const driver = (): 'postgres' | 'file' => (databaseUrl() ? 'postgres' : 'file');

type Row = {alias: string; data: Alias};

let poolPromise: Promise<import('pg').Pool> | undefined;

async function pool() {
  const url = databaseUrl();
  if (!url) throw new Error('未配置注册表数据库（TUNNEL_REGISTRY_DATABASE_URL / TUNNEL_AIO_DATABASE_URL）');
  if (!poolPromise) {
    const {default: pg} = await import('pg');
    poolPromise = Promise.resolve(new pg.Pool({connectionString: url, max: 3, connectionTimeoutMillis: 8000, statement_timeout: 15000}));
  }
  return poolPromise;
}

export async function listRows(settings: PortalSettings): Promise<Alias[]> {
  if (driver() === 'file') return loadRegistry(settings).aliases;
  const db = await pool();
  return (await db.query<Row>(`select alias, data from ${TABLE} order by alias`)).rows.map(row => normalizeAlias(row.data));
}

export async function writeRow(entry: Alias, by: string): Promise<void> {
  if (driver() === 'file') return;
  const db = await pool();
  await db.query(
    `insert into ${TABLE} (alias, data, updated_at, updated_by) values ($1, $2::jsonb, now(), $3)
     on conflict (alias) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`,
    [entry.alias, JSON.stringify(entry), by],
  );
}

export async function deleteRow(alias: string): Promise<void> {
  if (driver() === 'file') return;
  const db = await pool();
  await db.query(`delete from ${TABLE} where alias = $1`, [alias]);
}

/** 一次性把历史 JSON 灌进数据库（幂等，已存在以数据库为准）。 */
export async function importLegacy(settings: PortalSettings, file: string): Promise<{imported: string[]; skipped: string[]}> {
  if (driver() === 'file') throw new Error('未配置注册表数据库，无需导入');
  if (!existsSync(file)) return {imported: [], skipped: []};
  const legacy = (JSON.parse(readFileSync(file, 'utf8')) as {aliases?: Alias[]}).aliases ?? [];
  const db = await pool();
  const existing = new Set((await db.query<{alias: string}>(`select alias from ${TABLE}`)).rows.map(row => row.alias));
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const entry of legacy) {
    if (existing.has(entry.alias)) { skipped.push(entry.alias); continue; }
    await writeRow(entry, 'migrate-json');
    imported.push(entry.alias);
  }
  return {imported, skipped};
}
