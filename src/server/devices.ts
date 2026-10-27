import pg from 'pg';
import {connect, isIP} from 'node:net';
import {publishBinding, readBindings, setBinding} from './bindings.js';

export type Device = {id: string; label: string; status: string; address?: string; publish?: boolean};
export type DeviceDirectory = ReturnType<typeof deviceDirectory>;

/** 配对身份由 AIO 持有；这里仅保存身份到中继地址、以及「谁是发布节点」的绑定。 */
export function deviceDirectory(root: string) {
  const pool = process.env.TUNNEL_AIO_DATABASE_URL
    ? new pg.Pool({connectionString: process.env.TUNNEL_AIO_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000}) : undefined;
  async function list(): Promise<Device[]> {
    if (!pool) { return []; }
    const result = await pool.query<Device>(
      "SELECT id,label,CASE WHEN last_seen > now()-interval '90 seconds' THEN 'online' ELSE 'offline' END AS status FROM worker_devices WHERE state='active' AND tenant_id=$1 AND user_id=ANY($2::text[]) ORDER BY label",
      [process.env.TUNNEL_AIO_TENANT, (process.env.TUNNEL_AIO_USERS ?? '').split(',')],
    );
    const bindings = readBindings(root);
    return result.rows.map(device => ({
      ...device,
      address: bindings[device.id]?.address,
      publish: bindings[device.id]?.role === 'publish',
    }));
  }
  return {
    list,
    /**
     * 保存设备的中继地址与发布角色。
     * `address` 显式传空串表示清空地址；不传则保持原值（只改角色的场景）。
     * `role: 'publish'` 是互斥的——全表只有一个发布出口。
     */
    async bind(value: Record<string, unknown>) {
      const id = String(value.id ?? '');
      if (!(await list()).some(device => device.id === id)) { throw new Error('设备未配对或已撤销'); }
      const patch: {address?: string | null; role?: 'publish' | null} = {};
      if (value.address !== undefined) {
        const address = String(value.address).trim();
        if (address && !validHost(address)) { throw new Error('请输入有效的中继地址或主机名'); }
        patch.address = address || null;
      }
      if (value.role !== undefined) {
        const role = String(value.role);
        if (role !== '' && role !== 'publish') { throw new Error('发布角色只能是 publish 或空'); }
        patch.role = role === 'publish' ? 'publish' : null;
      }
      setBinding(root, id, patch);
      const saved = readBindings(root)[id];
      return {id, address: saved?.address, publish: saved?.role === 'publish'};
    },
    /** 发布节点（VPS / 中继出口）：发布 Caddy、证书与公网 DNS 的那台设备。 */
    publish(): {id: string; address?: string} | undefined {
      return publishBinding(readBindings(root));
    },
    async resolve(id: string): Promise<string> {
      const device = (await list()).find(item => item.id === id);
      if (!device) { throw new Error('设备未配对或已撤销'); }
      if (!device.address) { throw new Error(`${device.label} 尚未绑定中继地址`); }
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
    socket.once('error', () => reject(new Error(`目标服务 ${host}:${port} 不可达，请检查连接通道和服务监听`)));
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`目标服务 ${host}:${port} 连接超时`)); });
  });
}
