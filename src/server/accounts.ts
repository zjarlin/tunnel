import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';

export type DnsAccount = {id: string; label: string; provider: 'cloudflare' | 'huawei' | 'dnspod'; domain: string; zone: string; rawHost: string; key: string; secret: string};

/** 云凭据只在服务端解密，浏览器读取列表时只拿到首尾掩码，永远不返回整串密钥。 */
function hint(value: string): string {
  const text = value.trim();
  if (!text) { return ''; }
  if (text.length <= 8) { return '•'.repeat(text.length); }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function accounts(root: string) {
  const file = `${root}/accounts.enc`;
  function key() {
    const value = Buffer.from(process.env.TUNNEL_SECRET_KEY ?? '', 'base64');
    if (value.length !== 32) { throw new Error('TUNNEL_SECRET_KEY 必须是 32 字节 base64 密钥'); }
    return value;
  }
  function all(): DnsAccount[] {
    if (!existsSync(file)) { return []; }
    const data = readFileSync(file);
    const cipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
  }
  function get(id: string): DnsAccount {
    const account = all().find(item => item.id === id);
    if (!account) { throw new Error('DNS 账号不存在'); }
    return account;
  }
  return {
    get,
    // 只回显首尾各 4 位：界面据此确认「已配置」，浏览器与日志都拿不到整串密钥。
    list: () => all().map(({key: accessKey, secret: secretKey, ...publicFields}) => ({...publicFields, configured: true, keyHint: hint(accessKey), secretHint: hint(secretKey)})),
    save(value: Record<string, unknown>) {
      const current = all();
      const id = String(value.id ?? '');
      if (!/^[a-z0-9-]{1,48}$/.test(id)) { throw new Error('账号标识仅允许小写字母、数字和短横线'); }
      const old = current.find(item => item.id === id);
      const entry = Object.fromEntries(['label', 'provider', 'domain', 'zone', 'rawHost', 'key', 'secret'].map(name => [name, String(value[name] ?? '').trim()])) as Omit<DnsAccount, 'id'>;
      if (!entry.key && old) { entry.key = old.key; }
      if (!entry.secret && old) { entry.secret = old.secret; }
      if (!['cloudflare', 'huawei', 'dnspod'].includes(entry.provider) || !entry.label || !entry.key) { throw new Error('请填写账号名称、厂商与凭据'); }
      if (entry.provider !== 'cloudflare' && !entry.secret) { throw new Error('请填写 SecretKey / SK'); }
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(entry.domain) || entry.rawHost !== `raw.${entry.domain}`) { throw new Error('灰云入口必须是 raw.<域名>'); }
      const data = Buffer.from(JSON.stringify([...current.filter(item => item.id !== id), {id, ...entry}]));
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(), iv);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      writeFileSync(`${file}.tmp`, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {mode: 0o600});
      renameSync(`${file}.tmp`, file);
      return {id, configured: true};
    },
  };
}
