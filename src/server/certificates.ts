import {Client, crypto as acmeCrypto, axios} from 'acme-client';
import {X509Certificate} from 'node:crypto';
import {Resolver} from 'node:dns/promises';
import {Agent} from 'node:https';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import type {DnsAccount} from './accounts.js';
import {dnsChallenge} from './cloud-dns.js';
import {required} from './settings.js';

export type Certificate = {certificate: string; key: string; tags: string[]};

export function certificates(root: string) {
  const directory = `${root}/certificates`;
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const filename = (domain: string) => `${directory}/${domain}.json`;
  function read(domain: string): Certificate | undefined {
    if (!existsSync(filename(domain))) { return; }
    const value = JSON.parse(readFileSync(filename(domain), 'utf8')) as Certificate;
    const cert = new X509Certificate(value.certificate);
    if (!cert.checkHost(domain) || Date.parse(cert.validTo) <= Date.now()) { return; }
    return value;
  }
  return {
    list: (domains: string[]) => domains.map(read).filter((value): value is Certificate => !!value),
    async ensure(account: DnsAccount, domain: string): Promise<Certificate> {
      const existing = read(domain);
      if (existing && Date.parse(new X509Certificate(existing.certificate).validTo) - Date.now() > 30 * 86400_000) { return existing; }
      const keyFile = `${directory}/account.pem`;
      if (!existsSync(keyFile)) { writeFileSync(keyFile, await acmeCrypto.createPrivateKey(), {mode: 0o600}); }
      const client = new Client({directoryUrl: required('TUNNEL_ACME_DIRECTORY'), accountKey: readFileSync(keyFile), backoffAttempts: 12, backoffMin: 2000, backoffMax: 10_000});
      axios.defaults.timeout = 30_000;
      const family = Number(required('TUNNEL_ACME_IP_FAMILY'));
      if (![0, 4, 6].includes(family)) { throw new Error('ACME IP family 必须为 0、4 或 6'); }
      axios.defaults.httpsAgent = new Agent({family, keepAlive: true});
      const [key, csr] = await acmeCrypto.createCsr({commonName: domain});
      let cleanup: (() => Promise<void>) | undefined;
      let phase = 'ACME 连接';
      try {
        const certificate = await client.auto({
          csr, email: required('TUNNEL_ACME_EMAIL'), termsOfServiceAgreed: true,
          challengePriority: ['dns-01'], skipChallengeVerification: true,
          async challengeCreateFn(_authorization, challenge, value) {
            if (challenge.type !== 'dns-01') { throw new Error('只允许 DNS 证书验证'); }
            phase = '云 DNS TXT 写入';
            cleanup = await dnsChallenge(account, domain, value);
            phase = 'TXT 公网解析';
            const resolver = new Resolver({timeout: 3000, tries: 1});
            resolver.setServers(required('TUNNEL_ACME_RESOLVERS').split(','));
            for (let attempt = 0; attempt < 60; attempt += 1) {
              try {
                const records = await resolver.resolveTxt(`_acme-challenge.${domain}`);
                if (records.some(record => record.join('') === value)) { phase = 'ACME 验证'; return; }
              } catch (error) {
                if (!['ENODATA', 'ENOTFOUND', 'ETIMEOUT', 'ESERVFAIL'].includes(String((error as NodeJS.ErrnoException).code))) { throw error; }
              }
              await delay(5000);
            }
            throw new Error('证书 TXT 公网解析等待超时');
          },
          async challengeRemoveFn() { await cleanup?.(); cleanup = undefined; },
        });
        const result = {certificate, key: key.toString(), tags: [`tunnel-service:${domain}`]};
        writeFileSync(`${filename(domain)}.tmp`, JSON.stringify(result), {mode: 0o600});
        renameSync(`${filename(domain)}.tmp`, filename(domain));
        return result;
      } catch (error) {
        // 云 SDK 的异常可能含带签名的请求，不能直接暴露到页面或日志。
        const message = error instanceof Error ? error.message : '';
        if (/证书 TXT|其他证书工具/.test(message)) { throw error; }
        throw new Error(`${domain} ${phase}失败，请检查 DNS 权限及 ACME 出站连接`);
      } finally { await cleanup?.(); }
    },
  };
}
