import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';

/**
 * 密码本：平台级凭据登记（服务账号、数据库口令、云控制台等）。
 *
 * - 只在服务端解密：列表接口永远不返回密码，只有显式「查看」才回传单条口令。
 * - 落盘为 AES-256-GCM，密钥复用部署 `.env` 的 TUNNEL_SECRET_KEY，密文单独成文件，
 *   与 DNS 账号凭据互不影响；AAD 固定为 `vault.v1`，防止两类密文互相替换。
 * - 与 DNS 账号一致，不做脱敏以外的掩码回显：`hint` 只给长度提示，不给字符。
 */
export type VaultEntry = {
  id: string;
  name: string;
  category: string;
  url: string;
  username: string;
  password: string;
  note: string;
  updatedAt: string;
};
export type VaultPublicEntry = Omit<VaultEntry, 'password'> & {hasPassword: boolean; passwordLength: number};

const AAD = Buffer.from('vault.v1');
const MAX_ENTRIES = 500;

const text = (value: unknown, limit: number, label: string, required = false): string => {
  const result = String(value ?? '').trim();
  if (required && !result) { throw new Error(`请填写${label}`); }
  if (result.length > limit) { throw new Error(`${label}超过 ${limit} 个字符`); }
  return result;
};

export function vault(root: string) {
  const file = `${root}/vault.enc`;
  function key(): Buffer {
    const value = Buffer.from(process.env.TUNNEL_SECRET_KEY ?? '', 'base64');
    if (value.length !== 32) { throw new Error('TUNNEL_SECRET_KEY 必须是 32 字节 base64 密钥'); }
    return value;
  }
  function all(): VaultEntry[] {
    if (!existsSync(file)) { return []; }
    const data = readFileSync(file);
    const decipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(data.subarray(12, 28));
    const parsed = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()) as {entries?: VaultEntry[]};
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  }
  function save(entries: VaultEntry[]): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(AAD);
    const sealed = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({version: 1, entries}))), cipher.final()]);
    writeFileSync(`${file}.tmp`, Buffer.concat([iv, cipher.getAuthTag(), sealed]), {mode: 0o600});
    renameSync(`${file}.tmp`, file);
  }
  const mask = (entry: VaultEntry): VaultPublicEntry => {
    const {password, ...rest} = entry;
    return {...rest, hasPassword: password.length > 0, passwordLength: password.length};
  };
  return {
    list: (): VaultPublicEntry[] => all().map(mask).sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name)),
    reveal(id: string): {id: string; name: string; username: string; password: string} {
      const entry = all().find(item => item.id === id);
      if (!entry) { throw new Error('密码本条目不存在'); }
      if (!entry.password) { throw new Error('该条目还没有保存密码'); }
      return {id: entry.id, name: entry.name, username: entry.username, password: entry.password};
    },
    save(value: Record<string, unknown>): VaultPublicEntry {
      const current = all();
      const id = text(value.id, 64, '条目 ID') || randomBytes(8).toString('hex');
      const old = current.find(item => item.id === id);
      if (!old && current.length >= MAX_ENTRIES) { throw new Error(`最多登记 ${MAX_ENTRIES} 条`); }
      const password = typeof value.password === 'string' ? value.password : '';
      const entry: VaultEntry = {
        id,
        name: text(value.name, 80, '名称', true),
        category: text(value.category, 32, '分类') || '其他',
        url: text(value.url, 512, '地址'),
        username: text(value.username, 256, '账号'),
        // 留空表示沿用旧口令：编辑其他字段不需要重新输入密码。
        password: password ? text(password, 1024, '密码') : (old?.password ?? ''),
        note: text(value.note, 500, '备注'),
        updatedAt: new Date().toISOString(),
      };
      if (!entry.password) { throw new Error('请填写密码'); }
      const next = [...current.filter(item => item.id !== id), entry];
      save(next);
      return mask(entry);
    },
    remove(id: string): {id: string} {
      const current = all();
      if (!current.some(item => item.id === id)) { throw new Error('密码本条目不存在'); }
      save(current.filter(item => item.id !== id));
      return {id};
    },
    // 供 AIO 侧车与 CLI 复用：仅在服务端进程内可用，不经过 HTTP。
    get: (id: string): VaultEntry | undefined => all().find(item => item.id === id),
  };
}
