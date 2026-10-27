import type {VaultEntry, VaultPublicEntry} from './vault.js';
import type {Sheet, SheetCell} from './excel.js';

/**
 * 导出为 Excel：把「服务登记」与「密码本」两个控制台表格转成工作表数据。
 *
 * 只做数据整形，不碰 HTTP：口令是否明文由调用方决定（`/api/export.xlsx` 默认不带，
 * 必须显式 `?secrets=1`），避免导出逻辑自己就把明文漏出去。
 */

export type ServiceRow = {
  alias: string;
  suffix?: string;
  domain?: string;
  edges?: string[];
  scheme?: string;
  host?: string;
  port?: number;
  deviceId?: string;
  deviceLabel?: string;
  transport?: string;
  visibility?: string;
  dnsMode?: string;
  tlsServerName?: string;
  note?: string;
  readOnly?: boolean;
};

const visible: Record<string, string> = {internal: '仅内网', public: '公网'};
const transport: Record<string, string> = {easytier: 'EasyTier / 直连', frp: 'FRP 映射'};
const dnsMode: Record<string, string> = {managed: '自动管理 DNS', existing: '保留现有公网 DNS'};
const scheme: Record<string, string> = {http: 'HTTP', https: 'HTTPS', tcp: 'TCP'};

/** 容器不一定配了时区，统一按国内时间展示，避免导出后时间对不上。 */
export function localTime(value: string | number | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) { return ''; }
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

export function serviceSheet(items: ServiceRow[], suffix: string): Sheet {
  const rows: SheetCell[][] = [[
    '域名', '访问范围', '连接方式', '目标地址', '协议', '设备', 'DNS 方式', '上游 TLS 主机名', '备注', '管理方式',
  ]];
  for (const item of items) {
    const tcp = item.scheme === 'tcp';
    rows.push([
      `${item.alias}.${item.suffix || item.domain || suffix}`,
      visible[item.visibility ?? 'internal'] ?? item.visibility ?? '',
      tcp ? '现有 TCP 入口' : transport[item.transport ?? 'easytier'] ?? item.transport ?? '',
      tcp ? '—' : `${item.host || '设备本机'}:${item.port ?? ''}`,
      scheme[item.scheme ?? 'http'] ?? item.scheme ?? '',
      item.deviceLabel || item.deviceId || '入口直连',
      tcp ? '—' : dnsMode[item.dnsMode ?? 'managed'] ?? item.dnsMode ?? '',
      item.tlsServerName ?? '',
      item.note ?? '',
      item.readOnly ? '只读（外部目录）' : '控制台管理',
    ]);
  }
  return {name: '服务登记', rows};
}

export function vaultSheet(entries: Array<VaultEntry | VaultPublicEntry>, secrets: boolean): Sheet {
  const rows: SheetCell[][] = [['名称', '分类', '地址', '账号', '密码', '备注', '更新时间']];
  for (const entry of entries) {
    // 脱敏列表没有 password 键，只有 hasPassword；全量导出才带明文。
    const plain = 'password' in entry ? entry.password : '';
    const registered = 'password' in entry ? plain.length > 0 : Boolean(entry.hasPassword);
    rows.push([
      entry.name,
      entry.category,
      entry.url,
      entry.username,
      !registered ? '（未登记）' : secrets && plain ? plain : '（已登记，未导出明文）',
      entry.note,
      localTime(entry.updatedAt),
    ]);
  }
  return {name: secrets ? '密码本（含明文）' : '密码本', rows};
}

export function infoSheet(values: {exportedAt: string; console: string; secrets: boolean; services: number; entries: number}): Sheet {
  return {
    name: '导出说明',
    rows: [
      ['项目', '内容'],
      ['导出时间', values.exportedAt],
      ['控制台', values.console],
      ['服务登记', `${values.services} 条`],
      ['密码本', `${values.entries} 条`],
      ['口令', values.secrets ? '本次导出包含明文密码，请勿随意转发' : '未导出明文密码（仅提示已登记）'],
    ],
  };
}

/** RFC 5987 文件名：中文名在 Chrome/Firefox/WPS 都能正常落盘。 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
