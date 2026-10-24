import {readFileSync} from 'node:fs';
import type {Alias} from '../config/index.js';

/** 仅内网入口不能留下可绕过 Caddy 的公网 FRP 映射端口。 */
export function verifyPrivateFrpListener(item: Alias): void {
  if (item.transport !== 'frp' || item.visibility === 'public') { return; }
  if (item.host !== '127.0.0.1') { throw new Error('仅内网 FRP 映射必须使用入口本机 127.0.0.1'); }
  const listeners: Array<{address: string; ipv6: boolean}> = [];
  for (const protocol of ['tcp', 'tcp6']) {
    let table: string;
    try { table = readFileSync(`/proc/net/${protocol}`, 'utf8'); }
    catch (error) {
      if (protocol === 'tcp6' && (error as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
      throw new Error('无法检查 FRP 监听范围；仅内网 FRP 需要在 Linux 宿主网络中运行 Tunnel');
    }
    for (const line of table.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, port] = fields[1].split(':');
      if (fields[3] === '0A' && Number.parseInt(port, 16) === item.port) { listeners.push({address, ipv6: protocol === 'tcp6'}); }
    }
  }
  if (!listeners.length) { throw new Error('FRP 映射端口未监听，请先启动 frps TCP 映射或 frpc STCP visitor'); }
  if (listeners.some(item => item.address !== (item.ipv6 ? '00000000000000000000000001000000' : '0100007F'))) {
    throw new Error('FRP 映射端口存在非回环监听；请将 frps proxyBindAddr 或 frpc visitor bindAddr 设为 127.0.0.1 后重试');
  }
}
