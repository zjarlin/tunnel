import {BasicCredentials} from '@huaweicloud/huaweicloud-sdk-core';
import {DnsClient, ListPublicZonesRequest, ListRecordSetsByZoneRequest, CreateRecordSetRequest, CreateRecordSetRequestBody, UpdateRecordSetRequest, UpdateRecordSetReq, DeleteRecordSetRequest} from '@huaweicloud/huaweicloud-sdk-dns';
import tencent from 'tencentcloud-sdk-nodejs-dnspod';
import type {DnsAccount} from './accounts.js';

type RecordSet = {id: string; type: string; value: string; owner?: string; proxied?: boolean};
type Driver = {list(name: string): Promise<RecordSet[]>; write(name: string, value: string, owner: string, old?: RecordSet, type?: 'CNAME' | 'TXT'): Promise<void>; remove(record: RecordSet): Promise<void>};

/** 使用厂商 SDK 签名，不把 AK/SK 拼进 URL 或日志。 */
async function driver(account: DnsAccount): Promise<Driver> {
  if (account.provider === 'huawei') {
    const client = DnsClient.newBuilder().withCredential(new BasicCredentials().withAk(account.key).withSk(account.secret)).withEndpoint('https://dns.myhuaweicloud.com').build();
    const zones = account.zone ? undefined : await client.listPublicZones(new ListPublicZonesRequest().withName(account.domain).withSearchMode('equal'));
    const zone = account.zone || zones?.zones?.find(item => item.name === `${account.domain}.`)?.id;
    if (!zone) { throw new Error('华为云未找到该域名的公网 Zone'); }
    return {
      async list(name) {
        const response = await client.listRecordSetsByZone(new ListRecordSetsByZoneRequest(zone).withName(`${name}.`).withSearchMode('equal').withLimit(500));
        return (response.recordsets ?? []).filter(item => item.name === `${name}.`).map(item => ({id: item.id!, type: item.type!, value: item.records?.[0]?.replace(/\.$/, '') ?? '', owner: item.description}));
      },
      async write(name, value, owner, old, type = 'CNAME') {
        const record = type === 'TXT' ? JSON.stringify(value) : `${value}.`;
        if (old) {
          await client.updateRecordSet(new UpdateRecordSetRequest(zone, old.id).withBody(new UpdateRecordSetReq().withName(`${name}.`).withType(type).withRecords([record]).withTtl(300).withDescription(owner)));
        } else {
          await client.createRecordSet(new CreateRecordSetRequest(zone).withBody(new CreateRecordSetRequestBody(`${name}.`, type, [record]).withTtl(300).withDescription(owner)));
        }
      },
      async remove(record) { await client.deleteRecordSet(new DeleteRecordSetRequest(zone, record.id)); },
    };
  }
  if (account.provider === 'dnspod') {
    const client = new tencent.dnspod.v20210323.Client({credential: {secretId: account.key, secretKey: account.secret}, profile: {httpProfile: {reqTimeout: 15}}});
    return {
      async list(name) {
        const subdomain = name.slice(0, -(account.domain.length + 1));
        try {
          const response = await client.DescribeRecordList({Domain: account.domain, Subdomain: subdomain, Limit: 100});
          return (response.RecordList ?? []).map(item => ({id: String(item.RecordId), type: item.Type ?? '', value: (item.Value ?? '').replace(/\.$/, ''), owner: item.Remark}));
        } catch (error) {
          if ((error as {code?: string}).code === 'ResourceNotFound.NoDataOfRecord') { return []; }
          throw error;
        }
      },
      async write(name, value, owner, old, type = 'CNAME') {
        const fields = {Domain: account.domain, SubDomain: name.slice(0, -(account.domain.length + 1)), RecordType: type, RecordLine: '默认', Value: value, TTL: 600};
        const recordId = old ? Number(old.id) : (await client.CreateRecord(fields)).RecordId;
        if (!recordId) { throw new Error('DNSPod 未返回记录 ID'); }
        if (old) { await client.ModifyRecord({...fields, RecordId: recordId}); }
        await client.ModifyRecordRemark({Domain: account.domain, RecordId: recordId, Remark: owner});
      },
      async remove(record) { await client.DeleteRecord({Domain: account.domain, RecordId: Number(record.id)}); },
    };
  }
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {method, headers: {authorization: `Bearer ${account.key}`, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)});
    const result = await response.json() as {success: boolean; result: any};
    if (!response.ok || !result.success) { throw new Error(`Cloudflare DNS 请求失败（HTTP ${response.status}）`); }
    return result.result;
  }
  const zone = account.zone || (await call(`zones?name=${encodeURIComponent(account.domain)}`))[0]?.id;
  if (!zone) { throw new Error('Cloudflare 未找到域名 Zone'); }
  const base = `zones/${zone}/dns_records`;
  return {
    async list(name) { return (await call(`${base}?name=${encodeURIComponent(name)}`)).map((item: any) => ({id: item.id, type: item.type, value: item.content, owner: item.comment, proxied: item.proxied})); },
    async write(name, value, owner, old, type = 'CNAME') { await call(old ? `${base}/${old.id}` : base, old ? 'PATCH' : 'POST', {type, name, content: value, ttl: 300, proxied: false, comment: owner}); },
    async remove(record) { await call(`${base}/${record.id}`, 'DELETE'); },
  };
}

/** 只管理本系统的临时 TXT，不覆盖其他证书工具的验证记录。 */
export async function dnsChallenge(account: DnsAccount, domain: string, value: string): Promise<() => Promise<void>> {
  if (!domain.endsWith(`.${account.domain}`)) { throw new Error('证书域名不属于所选账号'); }
  const name = `_acme-challenge.${domain}`;
  const owner = `tunnel-acme:${domain}`;
  const client = await driver(account);
  const existing = await client.list(name);
  if (existing.some(item => item.owner !== owner || item.type !== 'TXT') || existing.length > 1) {
    throw new Error(`${name} 已被其他证书工具使用`);
  }
  await client.write(name, value, owner, existing[0], 'TXT');
  return async () => {
    for (const record of await client.list(name)) {
      if (record.owner === owner && record.type === 'TXT' && record.value.replace(/^"|"$/g, '') === value) { await client.remove(record); }
    }
  };
}

export async function dnsPlan(account: DnsAccount, name: string, visibility: string, mode: 'managed' | 'existing' = 'managed') {
  try {
    if (!name.endsWith(`.${account.domain}`) || name === account.rawHost) { throw new Error('域名不属于所选 DNS 账号，或占用灰云入口'); }
    const client = await driver(account);
    const records = (await client.list(name)).filter(item => ['A', 'AAAA', 'CNAME'].includes(item.type));
    if (mode === 'existing') {
      if (visibility !== 'public') { throw new Error('保留现有 DNS 仅适用于公网服务'); }
      if (!records.length) { throw new Error(`${name} 没有可保留的公网 DNS 记录`); }
      const snapshot = (items: RecordSet[]) => JSON.stringify(items.filter(item => ['A', 'AAAA', 'CNAME'].includes(item.type)).sort((a, b) => a.id.localeCompare(b.id)));
      return {
        async apply() {
          if (snapshot(await client.list(name)) !== snapshot(records)) { throw new Error(`${name} 的现有 DNS 记录已变化，请重新应用`); }
        },
      };
    }
    const owner = `tunnel:${name}`;
    if (records.some(item => item.owner !== owner)) { throw new Error(`${name} 已有其他系统管理的 DNS 记录，请先确认归属`); }
    const raw = visibility === 'public' ? await client.list(account.rawHost) : [];
    if (visibility === 'public' && !raw.some(item => item.type === 'A')) { throw new Error(`请先配置唯一灰云 A 记录 ${account.rawHost}`); }
    return {
      async apply() {
        if (visibility !== 'public') {
          for (const record of records) { await client.remove(record); }
          return;
        }
        if (records.some(item => item.type !== 'CNAME') || records.length > 1) { throw new Error('已有记录类型冲突'); }
        await client.write(name, account.rawHost, owner, records[0]);
        const verified = await client.list(name);
        if (!verified.some(item => item.type === 'CNAME' && item.value === account.rawHost && item.owner === owner)) { throw new Error('DNS 写入后读回不一致'); }
      },
    };
  } catch (error) {
    // SDK 错误对象可能附带带签名的请求配置，只对外返回业务消息或状态码。
    const message = error instanceof Error ? error.message : '';
    if (/域名|记录|灰云|DNS|Zone/.test(message) && !message.includes(account.key) && !message.includes(account.secret || '\0')) { throw new Error(message); }
    throw new Error(`${account.provider} DNS 认证或查询失败，请检查凭据及 Zone 权限`);
  }
}
