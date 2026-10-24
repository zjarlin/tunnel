import pg from 'pg';
import {connect, isIP} from 'node:net';
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';

export type Device = {id: string; label: string; status: string; address?: string};
export type DeviceDirectory = ReturnType<typeof deviceDirectory>;

/** 配对身份由 AIO 持有；这里仅保存身份到 EasyTier 地址的绑定。 */
export function deviceDirectory(root: string) {
  const pool = process.env.TUNNEL_AIO_DATABASE_URL
    ? new pg.Pool({connectionString: process.env.TUNNEL_AIO_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000}) : undefined;
  const file = `${root}/devices.json`;
  const bindings = (): Record<string, string> => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  async function list(): Promise<Device[]> {
    if (!pool) { return []; }
    const result = await pool.query<Device>(
      "SELECT id,label,CASE WHEN last_seen > now()-interval '90 seconds' THEN 'online' ELSE 'offline' END AS status FROM worker_devices WHERE state='active' AND tenant_id=$1 AND user_id=ANY($2::text[]) ORDER BY label",
      [process.env.TUNNEL_AIO_TENANT, (process.env.TUNNEL_AIO_USERS ?? '').split(',')],
    );
    const addresses = bindings();
    return result.rows.map(device => ({...device, address: addresses[device.id]}));
  }
  return {
    list,
    async bind(value: Record<string, unknown>) {
      const id = String(value.id ?? '');
      const address = String(value.address ?? '');
      if (!validHost(address)) { throw new Error('请输入有效的 EasyTier 地址或主机名'); }
      if (!(await list()).some(device => device.id === id)) { throw new Error('设备未配对或已撤销'); }
      const next = {...bindings(), [id]: address};
      writeFileSync(`${file}.tmp`, JSON.stringify(next), {mode: 0o600});
      renameSync(`${file}.tmp`, file);
      return {id, address};
    },
    async resolve(id: string): Promise<string> {
      const device = (await list()).find(item => item.id === id);
      if (!device) { throw new Error('设备未配对或已撤销'); }
      if (!device.address) { throw new Error(`${device.label} 尚未绑定 EasyTier 地址`); }
      return device.address;
    },
    close: () => pool?.end(),
  };
}

export function validHost(host: string): boolean {
  return isIP(host) === 4 || (host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host));
}

/** 发布前单独验证数据通道，配对在线不等同于目标服务可达。 */
export function probe(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({host, port});
    socket.setTimeout(5000);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', () => reject(new Error(`目标服务 ${host}:${port} 不可达，请检查 EasyTier 和服务监听`)));
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`目标服务 ${host}:${port} 连接超时`)); });
  });
}
