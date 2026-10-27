/**
 * 用 Cloudflare DNS-01 为 addzero.site 类域名签发/续签证书。
 *
 * 与 issue-certificate.mjs（华为云专用）互补：这里走 CF Token，一次可签多个域名。
 * 产物：
 *   1) `<TUNNEL_DATA>/certificates/<域名>.json`（控制台发布时直接加载，跳过重复签发）；
 *   2) 可选 `--out <目录>` 导出 `<tls-<域名点转横线>>/{fullchain.pem,privkey.pem}`，
 *      供 file-based 的 localmesh Caddy 站点（`tls <pem> <key>`）使用。
 *
 * 用法：
 *   TUNNEL_CF_TOKEN=... TUNNEL_CF_ZONE=... node scripts/issue-certificate-cf.mjs <域名> [...] [--out <目录>] [--force]
 * 环境变量缺失时从 TUNNEL_ENV_FILE（默认 /root/DockerCompose/tunnel/.env）读取。
 */
import acme from 'acme-client';
import {Resolver} from 'node:dns/promises';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : '';
const force = args.includes('--force');
const domains = args.filter((value, index) => !value.startsWith('--') && index !== outIndex + 1);
if (!domains.length) {
  console.error('用法: node scripts/issue-certificate-cf.mjs <域名> [...] [--out <目录>] [--force]');
  process.exit(2);
}

const envFile = process.env.TUNNEL_ENV_FILE ?? '/root/DockerCompose/tunnel/.env';
if ((!process.env.TUNNEL_CF_TOKEN || !process.env.TUNNEL_CF_ZONE) && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
const token = process.env.TUNNEL_CF_TOKEN;
const zone = process.env.TUNNEL_CF_ZONE;
// .env 里的 TUNNEL_DATA 是容器内路径（/data）；宿主上执行时回落到部署目录的数据盘。
const data = [process.env.TUNNEL_DATA, '/root/DockerCompose/tunnel/data'].find(path => path && existsSync(join(path, 'certificates'))) ?? '/root/DockerCompose/tunnel/data';
const email = process.env.TUNNEL_ACME_EMAIL ?? 'admin@addzero.site';
const resolvers = (process.env.TUNNEL_ACME_RESOLVERS ?? '1.1.1.1,223.5.5.5').split(',');
if (!token || !zone) throw new Error('缺少 TUNNEL_CF_TOKEN / TUNNEL_CF_ZONE');

const log = (...values) => console.log(new Date().toISOString().slice(11, 19), ...values);
const api = (path, method = 'GET', body) => fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records${path}`, {
  method,
  headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(15000),
}).then(async response => {
  const result = await response.json();
  return result;
});

const accountKeyFile = join(data, 'certificates', 'account.pem');
const client = new acme.Client({
  directoryUrl: process.env.TUNNEL_ACME_DIRECTORY ?? 'https://acme-v02.api.letsencrypt.org/directory',
  accountKey: readFileSync(accountKeyFile),
  backoffAttempts: 6,
  backoffMin: 1000,
  backoffMax: 6000,
});

/** 只清理本工具写的 TXT，遇到别的系统在同名记录上动手就报错。 */
async function challenge(domain, value) {
  const owner = `tunnel-acme:${domain}`;
  const name = `_acme-challenge.${domain}`;
  const existing = (await api(`?name=${encodeURIComponent(name)}`)).result ?? [];
  const mine = existing.filter(item => item.comment === owner && item.type === 'TXT');
  if (existing.length !== mine.length) throw new Error(`${name} 已有其他系统管理的记录，拒绝覆盖`);
  for (const item of mine) await api(`/${item.id}`, 'DELETE');
  const created = await api('', 'POST', {type: 'TXT', name, content: JSON.stringify(value), ttl: 60, proxied: false, comment: owner});
  if (!created.success) throw new Error(`${name} TXT 写入失败：${JSON.stringify(created.errors)}`);
  const resolver = new Resolver({timeout: 5000, tries: 2});
  resolver.setServers(resolvers);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const records = await resolver.resolveTxt(name);
      if (records.some(record => record.join('') === value)) return async () => { await api(`/${created.result.id}`, 'DELETE'); };
    } catch (error) {
      if (!['ENODATA', 'ENOTFOUND', 'ETIMEOUT', 'ESERVFAIL'].includes(String(error.code))) throw error;
    }
    await delay(5000);
  }
  throw new Error(`${name} 公网解析等待超时`);
}

function exportPem(domain, certificate, key) {
  if (!outDir) return;
  const directory = join(outDir, `tls-${domain.replaceAll('.', '-')}`);
  mkdirSync(directory, {recursive: true, mode: 0o755});
  writeFileSync(join(directory, 'fullchain.pem'), certificate, {mode: 0o644});
  writeFileSync(join(directory, 'privkey.pem'), key, {mode: 0o600});
  log('PEM exported to', directory);
}

for (const domain of domains) {
  const jsonFile = join(data, 'certificates', `${domain}.json`);
  if (!force && existsSync(jsonFile)) {
    const current = JSON.parse(readFileSync(jsonFile, 'utf8'));
    const cert = new X509Certificate(current.certificate);
    if (cert.checkHost(domain) && Date.parse(cert.validTo) - Date.now() > 30 * 86400_000) {
      log(domain, 'certificate still valid until', cert.validTo, '- reuse');
      exportPem(domain, current.certificate, current.key);
      continue;
    }
  }
  log(domain, 'issuing');
  let cleanup;
  try {
    const [key, csr] = await acme.crypto.createCsr({commonName: domain});
    const certificate = await client.auto({
      csr, email, termsOfServiceAgreed: true, challengePriority: ['dns-01'], skipChallengeVerification: true,
      async challengeCreateFn(_auth, challengeItem, value) {
        if (challengeItem.type !== 'dns-01') throw new Error('只允许 dns-01 验证');
        cleanup = await challenge(domain, value);
        log(domain, 'TXT visible, answering challenge');
      },
      async challengeRemoveFn() { await cleanup?.(); cleanup = undefined; },
    });
    mkdirSync(join(data, 'certificates'), {recursive: true, mode: 0o700});
    const payload = JSON.stringify({certificate, key: key.toString(), tags: [`tunnel-service:${domain}`]});
    writeFileSync(`${jsonFile}.tmp`, payload, {mode: 0o600});
    renameSync(`${jsonFile}.tmp`, jsonFile);
    log(domain, 'ISSUED until', new X509Certificate(certificate).validTo);
    exportPem(domain, certificate, key.toString());
  } finally {
    if (cleanup) await cleanup();
  }
}
