/**
 * DNS / 连通性 / 证书 / 访问策略四类 provider。
 *
 * 所有 provider 都只描述“期望态 → 变更计划 → 应用 → 校验”。云厂商适配器
 * 在未配置凭据时只生成可审计的计划，绝不伪造成功；本地 provider 才执行真实写入。
 */
import type {Alias, PortalSettings} from '../config/index.js';

export type ProviderKind = 'dns' | 'connectivity' | 'certificate' | 'policy';

export type Change = {
  kind: 'create' | 'update' | 'delete' | 'noop';
  resource: string;
  detail: string;
};

export type Plan = {
  provider: string;
  kind: ProviderKind;
  changes: Change[];
  warnings: string[];
  /** 需要真实写远端却缺少凭据时为 true；调用方必须阻止 apply。 */
  blocked?: boolean;
};

export type VerifyResult = {ok: boolean; detail: string};

export interface Provider {
  readonly name: string;
  readonly kind: ProviderKind;
  plan(alias: Alias, settings: PortalSettings): Promise<Plan>;
  apply(alias: Alias, settings: PortalSettings, plan: Plan): Promise<void>;
  verify(alias: Alias, settings: PortalSettings): Promise<VerifyResult>;
}

export const fqdn = (settings: PortalSettings, alias: string): string => `${alias}.${settings.suffix}`;

/** 与注册表归一规则保持一致：只有显式 public 才允许公网写入。 */
const isInternal = (alias: Alias): boolean =>
  (alias.visibility ?? (alias.lan === false ? 'public' : 'internal')) === 'internal';

const cloudConfig = (settings: PortalSettings, alias: Alias) => {
  const provider = alias.providers?.dns ?? settings.providers?.dns ?? 'local-dnsmasq';
  return {provider, config: settings.providers?.cloud?.[provider as 'cloudflare']};
};

const credential = (settings: PortalSettings, alias: Alias): string | undefined => {
  const {config} = cloudConfig(settings, alias);
  return config?.credentialsEnv ? process.env[config.credentialsEnv] : undefined;
};

type CloudRecord = {name: string; value: string; ttl: number};
type ExistingRecord = {id: string; value: string} | null;

const timeout = () => AbortSignal.timeout(15_000);
const redact = (text: string) => text.replace(/(token|key|secret)[^&\s"]*[=:]\s*[^&\s"]+/gi, '$1=<redacted>');

/**
 * 云 DNS 的公共行为：
 * - 先读远端现状，再产出 create / update / noop 计划（幂等）；
 * - 只有 internal 不写公网；public 必须 allowPublicWrite + 凭据 + 显式授权；
 * - verify 重新读取远端，不用本地计划冒充成功。
 */
abstract class CloudDnsProvider implements Provider {
  abstract readonly name: string;
  readonly kind = 'dns' as const;
  protected abstract zone(settings: PortalSettings, alias: Alias): string | undefined;
  protected abstract list(zone: string, name: string, token: string): Promise<ExistingRecord>;
  protected abstract create(zone: string, record: CloudRecord, token: string): Promise<void>;
  protected abstract update(zone: string, record: CloudRecord, existing: {id: string}, token: string): Promise<void>;

  async plan(alias: Alias, settings: PortalSettings): Promise<Plan> {
    const zone = this.zone(settings, alias);
    const {config} = cloudConfig(settings, alias);
    const warnings: string[] = [];
    const changes: Change[] = [];
    if (!zone) {
      warnings.push(`未配置 ${this.name}.zone，无法产生云 DNS 计划`);
      return {provider: this.name, kind: this.kind, changes, warnings, blocked: true};
    }
    if (isInternal(alias)) {
      return {
        provider: this.name,
        kind: this.kind,
        changes: [{kind: 'noop', resource: fqdn(settings, alias.alias), detail: 'internal 别名禁止创建公网记录'}],
        warnings,
      };
    }
    if (!config?.allowPublicWrite) {
      warnings.push('公网 DNS 写入未显式开启（allowPublicWrite=false），仅生成计划');
      return {provider: this.name, kind: this.kind, changes, warnings, blocked: true};
    }
    if (!alias.authorizedBy) {
      warnings.push('public 别名缺少 authorizedBy，拒绝公网写入');
      return {provider: this.name, kind: this.kind, changes, warnings, blocked: true};
    }
    const token = credential(settings, alias);
    if (!token) {
      warnings.push(`缺少凭据环境变量 ${config.credentialsEnv ?? '（未配置）'}，不执行真实写入`);
      return {provider: this.name, kind: this.kind, changes, warnings, blocked: true};
    }
    const name = fqdn(settings, alias.alias);
    const value = settings.lanIp ?? '';
    if (!value) {
      warnings.push('未配置 lanIp，公网 A 记录值将为空');
      return {provider: this.name, kind: this.kind, changes, warnings, blocked: true};
    }
    const record = {name, value, ttl: config.ttl ?? 120};
    try {
      const existing = await this.list(zone, name, token);
      if (!existing) {
        changes.push({kind: 'create', resource: `${this.name}:${name}`, detail: `A ${value} ttl=${record.ttl}`});
      } else if (existing.value === value) {
        changes.push({kind: 'noop', resource: `${this.name}:${name}`, detail: `已是 A ${value}`});
      } else {
        changes.push({kind: 'update', resource: `${this.name}:${name}`, detail: `A ${existing.value} -> ${value}`});
      }
      return {provider: this.name, kind: this.kind, changes, warnings};
    } catch (error) {
      warnings.push(`读取远端失败，未生成写入计划：${redact(error instanceof Error ? error.message : String(error))}`);
      return {provider: this.name, kind: this.kind, changes, warnings, blocked: true};
    }
  }

  async apply(alias: Alias, settings: PortalSettings, plan: Plan): Promise<void> {
    if (plan.blocked) throw new Error(`${this.name}: 计划未通过安全检查，拒绝写入`);
    const zone = this.zone(settings, alias);
    const token = credential(settings, alias);
    if (!zone || !token) throw new Error(`${this.name}: 缺少 zone 或凭据`);
    const {config} = cloudConfig(settings, alias);
    const name = fqdn(settings, alias.alias);
    const record = {name, value: settings.lanIp ?? '', ttl: config?.ttl ?? 120};
    const change = plan.changes.find(item => item.kind !== 'noop');
    if (!change) return;
    const existing = await this.list(zone, name, token);
    if (change.kind === 'create') {
      await this.create(zone, record, token);
      return;
    }
    if (change.kind === 'update' && existing) {
      await this.update(zone, record, existing, token);
      return;
    }
    throw new Error(`${this.name}: 远端状态与计划不一致（${change.kind}），请重新执行 plan`);
  }

  async verify(alias: Alias, settings: PortalSettings): Promise<VerifyResult> {
    if (isInternal(alias)) return {ok: true, detail: 'internal 别名不检查公网 DNS'};
    const zone = this.zone(settings, alias);
    const token = credential(settings, alias);
    if (!zone || !token) return {ok: false, detail: '缺少 zone 或凭据，无法校验公网记录'};
    try {
      const existing = await this.list(zone, fqdn(settings, alias.alias), token);
      const value = settings.lanIp ?? '';
      if (!existing) return {ok: false, detail: '公网记录不存在'};
      return existing.value === value
        ? {ok: true, detail: `公网 A ${existing.value} 已存在`}
        : {ok: false, detail: `公网 A 为 ${existing.value}，期望 ${value}`};
    } catch (error) {
      return {ok: false, detail: `公网校验失败：${redact(error instanceof Error ? error.message : String(error))}`};
    }
  }
}

type Json = Record<string, unknown>;

async function jsonRequest(url: string, init: RequestInit): Promise<Json> {
  const response = await fetch(url, {...init, signal: timeout()});
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${redact(text).slice(0, 500)}`);
  return text ? (JSON.parse(text) as Json) : {};
}

/** Cloudflare：zone 参数是 Zone ID，凭据是 API Token。 */
export class CloudflareDnsProvider extends CloudDnsProvider {
  readonly name = 'cloudflare';
  private recordType = 'A';
  private cnameSettings(settings: PortalSettings, alias: Alias): PortalSettings {
    const target = cloudConfig(settings, alias).config?.cnameTarget;
    this.recordType = target ? 'CNAME' : 'A';
    return target ? {...settings, lanIp: target} : settings;
  }
  override async plan(alias: Alias, settings: PortalSettings): Promise<Plan> {
    return super.plan(alias, this.cnameSettings(settings, alias));
  }
  override async apply(alias: Alias, settings: PortalSettings, plan: Plan): Promise<void> {
    return super.apply(alias, this.cnameSettings(settings, alias), plan);
  }
  override async verify(alias: Alias, settings: PortalSettings): Promise<VerifyResult> {
    return super.verify(alias, this.cnameSettings(settings, alias));
  }
  protected zone(settings: PortalSettings, alias: Alias) { return cloudConfig(settings, alias).config?.zone; }

  private base(zone: string) { return `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`; }
  private headers(token: string) { return {authorization: `Bearer ${token}`, 'content-type': 'application/json'}; }

  protected async list(zone: string, name: string, token: string): Promise<ExistingRecord> {
    const data = await jsonRequest(`${this.base(zone)}?type=${this.recordType}&name=${encodeURIComponent(name)}`, {headers: this.headers(token)});
    const rows = (data.result as Json[] | undefined) ?? [];
    const row = rows[0];
    if (!row) return null;
    return {id: String(row.id), value: String(row.content)};
  }

  protected async create(zone: string, record: CloudRecord, token: string): Promise<void> {
    await jsonRequest(this.base(zone), {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({type: this.recordType, name: record.name, content: record.value, ttl: record.ttl, proxied: false}),
    });
  }

  protected async update(zone: string, record: CloudRecord, existing: {id: string}, token: string): Promise<void> {
    await jsonRequest(`${this.base(zone)}/${existing.id}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({type: this.recordType, name: record.name, content: record.value, ttl: record.ttl, proxied: false}),
    });
  }
}

/**
 * 腾讯云 DNSPod：zone 参数是主域名（如 `example.com`），凭据是 `ID,Token`。
 * API 使用表单编码，响应 `status.code == "1"` 才表示成功。
 */
export class DnspodDnsProvider extends CloudDnsProvider {
  readonly name = 'dnspod';
  protected zone(settings: PortalSettings, alias: Alias) { return cloudConfig(settings, alias).config?.zone; }

  private async call(path: string, form: Record<string, string>, token: string): Promise<Json> {
    const body = new URLSearchParams({login_token: token, format: 'json', lang: 'cn', ...form});
    const response = await fetch(`https://dnsapi.cn/${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body,
      signal: timeout(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${redact(text).slice(0, 500)}`);
    const data = JSON.parse(text) as {status?: {code?: string; message?: string}; [key: string]: unknown};
    if (data.status?.code !== '1') throw new Error(`DNSPod: ${data.status?.code ?? '?'} ${data.status?.message ?? text}`);
    return data;
  }

  private split(zone: string, name: string): {domain: string; sub: string} {
    if (name === zone) return {domain: zone, sub: '@'};
    if (!name.endsWith(`.${zone}`)) throw new Error(`DNSPod: ${name} 不属于 zone ${zone}`);
    return {domain: zone, sub: name.slice(0, -(zone.length + 1))};
  }

  protected async list(zone: string, name: string, token: string): Promise<ExistingRecord> {
    const {domain, sub} = this.split(zone, name);
    const data = await this.call('Record.List', {domain, sub_domain: sub, record_type: 'A'}, token);
    const rows = (data.records as Json[] | undefined) ?? [];
    const row = rows.find(item => item.type === 'A');
    if (!row) return null;
    return {id: String(row.id), value: String(row.value)};
  }

  protected async create(zone: string, record: CloudRecord, token: string): Promise<void> {
    const {domain, sub} = this.split(zone, record.name);
    await this.call('Record.Create', {
      domain, sub_domain: sub, record_type: 'A', record_line: '默认', value: record.value, ttl: String(record.ttl),
    }, token);
  }

  protected async update(zone: string, record: CloudRecord, existing: {id: string}, token: string): Promise<void> {
    const {domain, sub} = this.split(zone, record.name);
    await this.call('Record.Modify', {
      domain, record_id: existing.id, sub_domain: sub, record_type: 'A', record_line: '默认',
      value: record.value, ttl: String(record.ttl),
    }, token);
  }
}

/**
 * 华为云 DNS：zone 参数是 Zone ID，凭据是 IAM 短期 X-Auth-Token。
 * 长期 AK/SK 签名不在这里实现，避免把签名逻辑伪装成“已支持”。
 */
export class HuaweiDnsProvider extends CloudDnsProvider {
  readonly name = 'huawei';
  protected zone(settings: PortalSettings, alias: Alias) { return cloudConfig(settings, alias).config?.zone; }

  private base(zone: string) { return `https://dns.myhuaweicloud.com/v2/zones/${zone}/recordsets`; }
  private headers(token: string) { return {'x-auth-token': token, 'content-type': 'application/json'}; }

  protected async list(zone: string, name: string, token: string): Promise<ExistingRecord> {
    const url = `${this.base(zone)}?name=${encodeURIComponent(`${name}.`)}&type=A`;
    const data = await jsonRequest(url, {headers: this.headers(token)});
    const rows = (data.recordsets as Json[] | undefined) ?? [];
    const row = rows.find(item => item.type === 'A');
    if (!row) return null;
    const values = (row.records as string[] | undefined) ?? [];
    return {id: String(row.id), value: String(values[0] ?? '')};
  }

  protected async create(zone: string, record: CloudRecord, token: string): Promise<void> {
    await jsonRequest(this.base(zone), {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({name: `${record.name}.`, type: 'A', ttl: record.ttl, records: [record.value]}),
    });
  }

  protected async update(zone: string, record: CloudRecord, existing: {id: string}, token: string): Promise<void> {
    await jsonRequest(`${this.base(zone)}/${existing.id}`, {
      method: 'PUT',
      headers: this.headers(token),
      body: JSON.stringify({name: `${record.name}.`, type: 'A', ttl: record.ttl, records: [record.value]}),
    });
  }
}

/** 本地 dnsmasq：只生成 address 覆盖，真实写入由 render 统一完成。 */
export class LocalDnsmasqProvider implements Provider {
  readonly name = 'local-dnsmasq';
  readonly kind = 'dns' as const;
  async plan(alias: Alias, settings: PortalSettings): Promise<Plan> {
    const name = fqdn(settings, alias.alias);
    if (!isInternal(alias)) {
      return {provider: this.name, kind: this.kind, changes: [], warnings: ['public 别名不使用内网 DNS 覆盖']};
    }
    return {
      provider: this.name,
      kind: this.kind,
      changes: [{kind: 'create', resource: name, detail: `address=/${name}/${settings.lanIp ?? ''}`}],
      warnings: settings.lanIp ? [] : ['未配置 lanIp'],
      blocked: !settings.lanIp,
    };
  }
  async apply(): Promise<void> { /* dnsmasq 由 render + reload 统一应用 */ }
  async verify(alias: Alias, settings: PortalSettings): Promise<VerifyResult> {
    return {ok: isInternal(alias) && Boolean(settings.lanIp), detail: isInternal(alias) ? '等待 render 后校验' : 'public 别名不写内网 DNS'};
  }
}

/** Caddy 站点：internal 必须 bind + remote_ip 白名单，否则 doctor 失败。 */
export class CaddyConnectivityProvider implements Provider {
  readonly name = 'caddy';
  readonly kind = 'connectivity' as const;
  async plan(alias: Alias, settings: PortalSettings): Promise<Plan> {
    const name = fqdn(settings, alias.alias);
    const warnings: string[] = [];
    if (isInternal(alias) && !settings.caddy?.bind) warnings.push('internal 别名缺少 caddy.bind，公网入口仍可能命中');
    if (isInternal(alias) && !(settings.caddy?.allow?.length)) warnings.push('internal 别名缺少 caddy.allow，来源不受限');
    return {
      provider: this.name,
      kind: this.kind,
      changes: [{kind: 'update', resource: `caddy:${name}`, detail: `reverse_proxy ${alias.scheme}://${alias.host}:${alias.port}`}],
      warnings,
      blocked: isInternal(alias) && (!settings.caddy?.bind || !(settings.caddy?.allow?.length)),
    };
  }
  async apply(): Promise<void> { /* 由 renderCaddy 统一写文件并校验 */ }
  async verify(alias: Alias, settings: PortalSettings): Promise<VerifyResult> {
    if (!isInternal(alias)) return {ok: true, detail: 'public 别名不做来源限制'};
    const ok = Boolean(settings.caddy?.bind && settings.caddy?.allow?.length);
    return {ok, detail: ok ? 'internal 站点已配置 bind + allowlist' : '缺少 bind 或 allowlist'};
  }
}

export class InternalCaProvider implements Provider {
  readonly name = 'internal-ca';
  readonly kind = 'certificate' as const;
  async plan(): Promise<Plan> {
    return {provider: this.name, kind: this.kind, changes: [], warnings: ['证书由 localmesh Caddy 的 internal issuer 统一签发']};
  }
  async apply(): Promise<void> {}
  async verify(): Promise<VerifyResult> { return {ok: true, detail: 'internal-ca 由 Caddy 负责'}; }
}

export class AcmeProvider implements Provider {
  readonly name = 'acme';
  readonly kind = 'certificate' as const;
  async plan(): Promise<Plan> {
    return {provider: this.name, kind: this.kind, changes: [], warnings: ['ACME 需要外部可达的 80/443 与 DNS 凭据，本地不伪造签发'], blocked: true};
  }
  async apply(): Promise<void> { throw new Error('ACME 未配置授权，拒绝写入'); }
  async verify(): Promise<VerifyResult> { return {ok: false, detail: 'ACME 需要真实远端验证'}; }
}

/** 策略 provider 只做判定；真正的 404 由 Caddy 渲染保证。 */
export class LanAllowlistProvider implements Provider {
  readonly name = 'lan-allowlist';
  readonly kind = 'policy' as const;
  async plan(alias: Alias, settings: PortalSettings): Promise<Plan> {
    if (!isInternal(alias)) return {provider: this.name, kind: this.kind, changes: [], warnings: ['public 别名需显式授权']};
    return {
      provider: this.name,
      kind: this.kind,
      changes: [{kind: 'noop', resource: fqdn(settings, alias.alias), detail: `allow ${settings.caddy?.allow?.join(' ') ?? ''} deny ${settings.caddy?.denyStatus ?? 404}`}],
      warnings: [],
    };
  }
  async apply(): Promise<void> {}
  async verify(alias: Alias, settings: PortalSettings): Promise<VerifyResult> {
    if (!isInternal(alias) && !alias.authorizedBy) return {ok: false, detail: 'public 别名缺少 authorizedBy'};
    return {ok: true, detail: '策略满足'};
  }
}

export function dnsProvider(settings: PortalSettings, alias: Alias): Provider {
  const name = alias.providers?.dns ?? settings.providers?.dns ?? 'local-dnsmasq';
  switch (name) {
    case 'local-dnsmasq': return new LocalDnsmasqProvider();
    case 'cloudflare': return new CloudflareDnsProvider();
    case 'dnspod': return new DnspodDnsProvider();
    case 'huawei': return new HuaweiDnsProvider();
    default: throw new Error(`不支持的 DNS provider：${String(name)}`);
  }
}

export function connectivityProvider(settings: PortalSettings, alias: Alias): Provider {
  const name = alias.providers?.connectivity ?? settings.providers?.connectivity ?? 'caddy';
  switch (name) {
    case 'caddy': return new CaddyConnectivityProvider();
    case 'aio-tunnel':
    case 'cloudflared':
      return {
        name,
        kind: 'connectivity',
        async plan() {
          return {
            provider: name,
            kind: 'connectivity',
            changes: [],
            warnings: [`${name} 由 AIO 设备隧道/外部隧道管理；请在隧道侧用设备配对与短时票据校验，不在本地 Caddy 伪造成功`],
            blocked: true,
          };
        },
        async apply() { throw new Error(`${name} 需要外部隧道编排，拒绝本地写入`); },
        async verify() { return {ok: false, detail: `${name} 需要真实隧道健康检查（AIO 设备在线 + 目标允许 + 票据有效）`}; },
      };
    default: throw new Error(`不支持的连通性 provider：${String(name)}`);
  }
}

export function certificateProvider(settings: PortalSettings, alias: Alias): Provider {
  const name = alias.providers?.certificate ?? settings.providers?.certificate ?? 'internal-ca';
  return name === 'acme' ? new AcmeProvider() : new InternalCaProvider();
}

export function policyProvider(settings: PortalSettings, alias: Alias): Provider {
  const name = alias.providers?.policy ?? settings.providers?.policy ?? 'lan-allowlist';
  if (name === 'public') {
    return {
      name,
      kind: 'policy',
      async plan() { return {provider: name, kind: 'policy', changes: [], warnings: ['需显式 public 授权']}; },
      async apply() {},
      async verify() { return {ok: true, detail: 'public 策略由注册表授权字段保证'}; },
    };
  }
  if (name === 'aio-auth') {
    return {
      name,
      kind: 'policy',
      async plan() { return {provider: name, kind: 'policy', changes: [], warnings: ['AIO 认证由应用自身负责']}; },
      async apply() {},
      async verify() { return {ok: true, detail: 'AIO 认证由应用负责'}; },
    };
  }
  return new LanAllowlistProvider();
}

export function providersFor(settings: PortalSettings, alias: Alias): Provider[] {
  return [
    dnsProvider(settings, alias),
    connectivityProvider(settings, alias),
    certificateProvider(settings, alias),
    policyProvider(settings, alias),
  ];
}

export {isInternal};
