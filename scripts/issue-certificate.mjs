/**
 * 独立签发 tunnel 服务证书（DNS-01，华为云/Cloudflare/DNSPod 由 accounts.enc 决定）。
 *
 * 用途：控制台自动签发失败但需要补齐/预签证书时使用；产物写入
 * `<TUNNEL_DATA>/certificates/<域名>.json`，控制台发布时会自动加载并跳过重复签发。
 *
 * 用法：
 *   TUNNEL_SECRET_KEY=... node scripts/issue-certificate.mjs tj-teamcity.lyokm.cn [更多域名...]
 * 环境：TUNNEL_DATA（默认 /root/DockerCompose/tunnel/data）、TUNNEL_ACME_EMAIL、TUNNEL_ACME_RESOLVERS
 */
import {createDecipheriv, X509Certificate} from 'node:crypto';
import {readFileSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {Resolver} from 'node:dns/promises';
import {Agent} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import acme from 'acme-client';
import axios from 'axios';
import {DnsClient, ListRecordSetsByZoneRequest, CreateRecordSetRequest, CreateRecordSetRequestBody, DeleteRecordSetRequest} from '@huaweicloud/huaweicloud-sdk-dns';
import {BasicCredentials} from '@huaweicloud/huaweicloud-sdk-core';

const data = process.env.TUNNEL_DATA ?? '/root/DockerCompose/tunnel/data';
const email = process.env.TUNNEL_ACME_EMAIL ?? 'admin@addzero.site';
const resolvers = (process.env.TUNNEL_ACME_RESOLVERS ?? '223.5.5.5,119.29.29.29').split(',');
const domains = process.argv.slice(2);
if (!domains.length) {
  console.error('用法: node scripts/issue-certificate.mjs <域名> [更多域名...]');
  process.exit(2);
}

function account() {
  const key = process.env.TUNNEL_SECRET_KEY;
  if (!key) throw new Error('缺少 TUNNEL_SECRET_KEY');
  const raw = readFileSync(`${data}/accounts.enc`);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const list = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
  const match = list.find(item => domains.some(domain => domain.endsWith(`.${item.domain}`)));
  if (!match) throw new Error('没有匹配的 DNS 账号');
  if (match.provider !== 'huawei') throw new Error(`此脚本目前只实现华为云 DNS，账号 ${match.id} 是 ${match.provider}`);
  return match;
}

const acc = account();
const dns = DnsClient.newBuilder()
  .withCredential(new BasicCredentials().withAk(acc.key).withSk(acc.secret))
  .withEndpoint('https://dns.myhuaweicloud.com')
  .build();

async function records(name) {
  const response = await dns.listRecordSetsByZone(new ListRecordSetsByZoneRequest(acc.zone).withName(`${name}.`).withSearchMode('equal').withLimit(500));
  return (response.recordsets ?? []).filter(item => item.name === `${name}.`).map(item => ({id: item.id, type: item.type, value: (item.records?.[0] ?? '').replace(/^"|"$/g, '').replace(/\.$/, ''), owner: item.description}));
}

async function writeTxt(name, value) {
  const owner = `tunnel-acme:${name.replace(/^_acme-challenge\./, '')}`;
  const existing = await records(name);
  const stale = existing.filter(item => item.owner === owner && item.type === 'TXT');
  if (existing.length !== stale.length) {
    throw new Error(`${name} 已有其他系统管理的记录（${existing.map(item => `${item.type}/${item.owner ?? '无主'}`).join(',')}），拒绝覆盖`);
  }
  // 上次中断留下的同名 TXT 先清掉，避免 ACME 校验读到旧值。
  for (const record of stale) { await dns.deleteRecordSet(new DeleteRecordSetRequest(acc.zone, record.id)); }
  await dns.createRecordSet(new CreateRecordSetRequest(acc.zone).withBody(
    new CreateRecordSetRequestBody(`${name}.`, 'TXT', [JSON.stringify(value)]).withTtl(300).withDescription(owner),
  ));
  return async () => {
    for (const record of await records(name)) {
      if (record.owner === owner) await dns.deleteRecordSet(new DeleteRecordSetRequest(acc.zone, record.id));
    }
  };
}

async function waitFor(name, value) {
  // 先查权威 NS（写入即生效），再等公共解析器；递归 DNS 的负缓存会让公共查询滞后。
  const resolver = new Resolver({timeout: 5000, tries: 2});
  // Resolver.setServers 只接受 IP：先解析权威 NS 地址。
  const authoritative = await new Resolver({timeout: 5000, tries: 1}).resolve4('ns1.huaweicloud-dns.com').catch(() => []);
  resolver.setServers([...resolvers, ...authoritative]);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const txt = await resolver.resolveTxt(name);
      if (txt.some(item => item.join('') === value)) {
        await delay(5000);
        return;
      }
    } catch (error) {
      if (!['ENODATA', 'ENOTFOUND', 'ETIMEOUT', 'ESERVFAIL'].includes(error.code)) throw error;
    }
    await delay(6000);
  }
  throw new Error(`${name} 的 TXT 未在公网生效`);
}

const directory = `${data}/certificates`;
const accountKey = `${directory}/account.pem`;
axios.defaults.timeout = 45_000;
axios.defaults.maxRedirects = 0;
axios.defaults.httpsAgent = new Agent({family: 4, keepAlive: true});
const client = new acme.Client({directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory', accountKey: readFileSync(accountKey), backoffAttempts: 6, backoffMin: 2000, backoffMax: 10_000});

for (const domain of domains) {
  const target = `${directory}/${domain}.json`;
  if (existsSync(target)) {
    const current = JSON.parse(readFileSync(target, 'utf8'));
    if (Date.parse(new X509Certificate(current.certificate).validTo) - Date.now() > 30 * 86400_000) {
      console.log(`skip ${domain}（现有证书仍有效）`);
      continue;
    }
  }
  const [key, csr] = await acme.crypto.createCsr({commonName: domain});
  let cleanup;
  try {
    const certificate = await client.auto({
      csr, email, termsOfServiceAgreed: true, challengePriority: ['dns-01'], skipChallengeVerification: true,
      async challengeCreateFn(_authorization, challenge, value) {
        if (challenge.type !== 'dns-01') throw new Error('只允许 DNS 验证');
        cleanup = await writeTxt(`_acme-challenge.${domain}`, value);
        await waitFor(`_acme-challenge.${domain}`, value);
      },
      async challengeRemoveFn() { await cleanup?.(); cleanup = undefined; },
    });
    writeFileSync(`${target}.tmp`, JSON.stringify({certificate, key: key.toString(), tags: [`tunnel-service:${domain}`]}), {mode: 0o600});
    renameSync(`${target}.tmp`, target);
    console.log(`ok ${domain}`);
  } catch (error) {
    const detail = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : '';
    console.error(`fail ${domain}: ${error?.message ?? error} ${detail}`);
    process.exitCode = 1;
  } finally {
    await cleanup?.();
  }
}
