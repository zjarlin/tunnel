import {readFileSync} from 'node:fs';

export interface TcpEndpoint {
  alias: string;
  domain: string;
  host: string;
  port: number;
  scheme: 'tcp';
  visibility: 'internal';
  transport: 'easytier';
  dnsMode: 'managed';
  readOnly: true;
  deviceLabel: string;
  note: string;
}

/** 只展示现有 TCP 入口的验证结果；不把数据库端口交给 HTTP 发布器。 */
export function tcpCatalog(file: string | undefined): TcpEndpoint[] {
  if (!file) { return []; }
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  if (catalog.version !== 1 || !Array.isArray(catalog.items)) { throw new Error('TCP 服务目录格式无效'); }
  const aliases = new Set<string>();
  return catalog.items.map((item: Record<string, unknown>) => {
    const {alias, domain, port, deviceLabel, note} = item;
    if (typeof alias !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias) || aliases.has(alias)) { throw new Error('TCP 服务别名无效或重复'); }
    if (typeof domain !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) { throw new Error('TCP 服务域名无效'); }
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) { throw new Error('TCP 服务端口无效'); }
    if (typeof deviceLabel !== 'string' || !deviceLabel.trim() || typeof note !== 'string') { throw new Error('TCP 服务说明缺失'); }
    aliases.add(alias);
    return {alias, domain, host: `${alias}.${domain}`, port: Number(port), scheme: 'tcp', visibility: 'internal', transport: 'easytier', dnsMode: 'managed', readOnly: true, deviceLabel, note};
  });
}
