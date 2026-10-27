/**
 * 服务入口面板与壳之间共享的数据契约。
 * 字段来自 `GET /api/services`、`/api/devices`、`/api/accounts`、`/api/publications`，
 * 两个部署方式（独立控制台 / AIO 内嵌页）读的是同一批接口，因此类型只需要一份。
 */
export interface DomainService {
  alias: string;
  domain?: string;
  suffix?: string;
  host: string;
  port: number;
  scheme: 'http' | 'https' | 'tcp';
  visibility: 'internal' | 'public';
  transport?: 'easytier' | 'frp';
  dnsMode?: 'managed' | 'existing';
  deviceId?: string;
  deviceLabel?: string;
  accountId?: string;
  tlsServerName?: string;
  note?: string;
  readOnly?: boolean;
  edges?: Array<'localmesh' | 'home-edge'>;
}

export interface DomainDevice {
  id: string;
  label: string;
  status: string;
  address?: string;
}

export interface DnsAccount {
  id: string;
  label: string;
  domain: string;
  provider: string;
  zone?: string;
  rawHost?: string;
}

export interface Publication {
  at?: number;
  state: string;
  routes?: string[];
  steps?: Array<{step: string; state: string; detail?: string}>;
}

export interface Directory {
  registry: {domain: string; items: DomainService[]; status: Publication | null};
  devices: {items: DomainDevice[]};
  accounts: {items: DnsAccount[]};
  navigationChanged?: boolean;
  canConsolidate?: boolean;
  navigationWarning?: string;
}
