import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {readFileSync, existsSync} from 'node:fs';

/** 门户配置：所有宿主相关的值都来自此处，源码不写死域名、网段或部署目录。 */
export type ResolverProviderName = 'dnsmasq' | 'none';
export type DnsProviderName = 'local-dnsmasq' | 'cloudflare' | 'dnspod' | 'huawei';
export type ConnectivityProviderName = 'caddy' | 'aio-tunnel' | 'cloudflared';
export type CertificateProviderName = 'internal-ca' | 'acme';
export type PolicyProviderName = 'lan-allowlist' | 'aio-auth' | 'public';

export type ResolverConfig = {
  port: number;
  upstreams: string[];
  configFile?: string;
  service?: string;
  dnsmasqBinary?: string;
  /** 可为 `dnsmasq` 或 `none`；`none` 时只生成文件，不触碰宿主。 */
  provider?: ResolverProviderName;
  /** 仅用于本机校验：例如 `dnsmasq --test --conf-file=...`。 */
  testCommand?: string[];
  /**
   * 生成“片段”还是“完整配置”。
   * 系统 dnsmasq 已监听 53 时只能输出片段（只含 address/server），由主配置 conf-dir 引入；
   * 生成完整配置会与 00-edge.conf 的 port/listen-address 冲突。
   */
  fragment?: boolean;
};

export type PortalConfig = {
  root: string;
  container?: string;
  aliasesDir?: string;
  mapPrefix: string;
  reload?: boolean;
};

export type GatewayConfig = {
  address?: string;
  adapter: 'xiaomi' | 'none';
  fallbackDns?: string;
};

export type CaddyConfig = {
  /** 站点片段输出目录，通常为 localmesh 的 `caddy/sites`。 */
  sitesDir?: string;
  /** 生成文件前缀，默认 `portal-`，避免覆盖人工维护的站点。 */
  prefix?: string;
  /** 仅内网站点绑定到的入口地址（必须显式配置，源码不写死）。 */
  bind?: string;
  /** 内网允许来源网段；为空时仅允许 loopback。 */
  allow?: string[];
  /** `caddy validate` 使用的可执行文件；留空则只做静态校验。 */
  binary?: string;
  /** Caddy 容器的 reload 命令（可选）。 */
  reload?: string;
  /** 未匹配请求的响应码，默认 404。 */
  denyStatus?: number;
};

/** 云 DNS 的写操作需要显式凭据；凭据只从环境变量读取，不落注册表。 */
export type CloudProviderConfig = {
  enabled: boolean;
  zone?: string;
  ttl?: number;
  credentialsEnv?: string;
  /** 公网写入必须显式开启；默认关闭。 */
  allowPublicWrite?: boolean;
  /** 公网别名统一指向 raw 入口，避免各自维护 A 记录。 */
  cnameTarget?: string;
};

export type ProvidersConfig = {
  dns: DnsProviderName;
  connectivity: ConnectivityProviderName;
  certificate: CertificateProviderName;
  policy: PolicyProviderName;
  cloud?: Partial<Record<DnsProviderName, CloudProviderConfig>>;
};

export type PortalSettings = {
  suffix: string;
  mode: 'lan' | 'hosts' | 'none';
  lanIp?: string;
  hostsFile?: string;
  resolver: ResolverConfig;
  portal: PortalConfig;
  gateway: GatewayConfig;
  caddy?: CaddyConfig;
  providers?: ProvidersConfig;
};

/**
 * 一条别名登记。
 *
 * `visibility` 是安全边界：`internal` 永不产生公网 DNS 记录，且 Caddy 必须同时
 * 绑定入口地址并校验来源网段。旧数据只有 `lan` 字段时按 `internal` 处理。
 */
export type Alias = {
  alias: string;
  domain?: string;
  deviceId?: string;
  accountId?: string;
  dnsMode?: 'managed' | 'existing';
  transport?: 'easytier' | 'frp';
  tlsServerName?: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  /** 兼容旧注册表；新代码以 visibility 为准。 */
  lan?: boolean;
  visibility?: 'internal' | 'public';
  note?: string;
  /** 单条覆盖全局 provider；用于把某个别名放在另一朵云或另一套网关上。 */
  providers?: Partial<Omit<ProvidersConfig, 'cloud'>>;
  /** 公网写入的人工授权标识（必填才允许 public）。 */
  authorizedBy?: string;
};

export type Registry = {aliases: Alias[]};

const DEFAULTS = (): PortalSettings & {providers: ProvidersConfig} => ({
  suffix: '',
  mode: 'lan',
  lanIp: '',
  hostsFile: '/etc/hosts',
  resolver: {port: 53, upstreams: ['223.5.5.5', '114.114.114.114'], provider: 'dnsmasq'},
  portal: {root: join(homedir(), '.config', 'aio-portal'), mapPrefix: '10-alias', reload: true},
  gateway: {adapter: 'xiaomi', fallbackDns: '223.5.5.5'},
  caddy: {prefix: 'portal-', allow: ['127.0.0.1/32'], denyStatus: 404},
  providers: {
    dns: 'local-dnsmasq',
    connectivity: 'caddy',
    certificate: 'internal-ca',
    policy: 'lan-allowlist',
  },
});

/** 解析生效配置：命令行 > 环境变量 > 配置文件 > 内置中性默认值。 */
export function loadSettings(rootOverride?: string): PortalSettings {
  const base = DEFAULTS();
  const root = resolve(rootOverride ?? process.env.AIO_PORTAL_HOME ?? base.portal.root);
  const configFile = join(root, 'aio-portal.json');
  let file: Partial<PortalSettings> = {};
  if (existsSync(configFile)) file = JSON.parse(readFileSync(configFile, 'utf8')) as Partial<PortalSettings>;
  const merged: PortalSettings = {
    ...base,
    ...file,
    resolver: {...base.resolver, ...file.resolver},
    portal: {...base.portal, ...file.portal, root},
    gateway: {...base.gateway, ...file.gateway},
    caddy: {...base.caddy, ...file.caddy},
    providers: {...base.providers, ...file.providers},
  };
  if (!merged.suffix) throw new Error(`缺少域名后缀配置，请在 ${configFile} 中设置 suffix`);
  merged.portal.root = root;
  merged.resolver.configFile ??= join(root, 'dns', 'aio-portal.conf');
  merged.portal.aliasesDir ??= join(root, 'nginx', 'aliases.d');
  if (merged.caddy && !merged.caddy.sitesDir) merged.caddy.sitesDir = join(root, 'caddy', 'sites');
  return merged;
}

export const registryFile = (s: PortalSettings) => join(s.portal.root, 'aliases.json');

/** 对旧数据做归一：`visibility` 缺省时按 `lan` 推导，缺省视作 internal。 */
export function normalizeAlias(item: Alias): Alias {
  const visibility = item.visibility ?? (item.lan === false ? 'public' : 'internal');
  return {...item, visibility, lan: visibility === 'internal'};
}

export function loadRegistry(s: PortalSettings): Registry {
  const file = registryFile(s);
  if (!existsSync(file)) return {aliases: []};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Registry;
  return {aliases: (parsed.aliases ?? []).map(normalizeAlias)};
}
