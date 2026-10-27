/**
 * 设备出网绑定：配对身份由 AIO 持有，这里只保存「身份 → 中继地址 / 角色」。
 *
 * 两种角色：
 * - `publish`：发布节点（VPS / 中继出口），全表唯一，承担 Caddy、证书与公网 DNS；
 * - 无角色：普通被发布设备（只是这条服务跑在哪台机器上）。
 *
 * 落盘保持向后兼容：历史格式是 `{"<id>": "<地址>"}`，读入时归一成对象，
 * 下次写入自动升级成 `{"<id>": {"address": "...", "role": "publish"}}`。
 */
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';

export type DeviceRole = 'publish';
export type Binding = {address?: string; role?: DeviceRole};
export type Bindings = Record<string, Binding>;

/** 历史与新版混存时的归一：字符串直接当地址，对象原样保留。 */
export function normalizeBindings(raw: unknown): Bindings {
  if (!raw || typeof raw !== 'object') return {};
  const out: Bindings = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') { if (value) out[id] = {address: value}; continue; }
    if (!value || typeof value !== 'object') continue;
    const item = value as Binding;
    const binding: Binding = {};
    if (typeof item.address === 'string' && item.address) binding.address = item.address;
    if (item.role === 'publish') binding.role = 'publish';
    if (binding.address || binding.role) out[id] = binding;
  }
  return out;
}

export function bindingsPath(root: string): string { return `${root}/devices.json`; }

export function readBindings(root: string): Bindings {
  const file = bindingsPath(root);
  if (!existsSync(file)) return {};
  try { return normalizeBindings(JSON.parse(readFileSync(file, 'utf8'))); } catch { return {}; }
}

function write(root: string, bindings: Bindings): void {
  const file = bindingsPath(root);
  writeFileSync(`${file}.tmp`, JSON.stringify(bindings), {mode: 0o600});
  renameSync(`${file}.tmp`, file);
}

/**
 * 合并写入。字段语义：
 * - `address`：字符串=写入，`null`=清空，`undefined`=保持；
 * - `role`：`'publish'`=设为发布节点（同时清掉其它条目的同类角色，保证全机唯一），`null`=取消，`undefined`=保持。
 */
export function setBinding(root: string, id: string, patch: {address?: string | null; role?: DeviceRole | null}): Bindings {
  const next = readBindings(root);
  const merged: Binding = {...next[id]};
  if (patch.address === null) delete merged.address;
  else if (patch.address !== undefined) merged.address = patch.address;
  if (patch.role === null && merged.role === 'publish') delete merged.role;
  else if (patch.role === 'publish') {
    merged.role = 'publish';
    for (const key of Object.keys(next)) if (key !== id) delete next[key].role;
  }
  if (merged.address || merged.role) next[id] = merged; else delete next[id];
  write(root, next);
  return next;
}

/** 当前发布节点；没有标记时返回 undefined，调用方必须显式处理而不要猜。 */
export function publishBinding(bindings: Bindings): {id: string; address?: string} | undefined {
  const hit = Object.entries(bindings).find(([, value]) => value.role === 'publish');
  return hit ? {id: hit[0], address: hit[1].address} : undefined;
}
