/**
 * 服务目标地址解析：登记表里的 `host` 与设备绑定的中继地址谁优先。
 *
 * 三种情况必须分清，否则发布时探测的是错的地址：
 * - 没绑设备：`host` 就是最终目标（内网入口直连的服务）。
 * - 绑了设备且填了显式主机：按填写的目标走（设备所在网段里的服务）。
 * - 绑了设备但目标留空：用设备自己的中继地址，表示「服务跑在那台设备上」。
 *
 * 回环地址是特例：只有「目标就在发布节点本机」时才允许写 `127.0.0.1`。
 * 其它设备的回环只能在那台设备上访问，从发布节点探测必然失败，
 * 所以这里直接报错而不是静默换成中继地址。
 */
export type TargetInput = {deviceId?: string; host?: string};

export function resolveHost(item: TargetInput, outletId: string | undefined, address: string): string {
  const host = String(item.host ?? '').trim();
  const local = host === '127.0.0.1' || host === 'localhost';
  if (!local) { return host || address; }
  if (item.deviceId === outletId) { return '127.0.0.1'; }
  throw new Error('设备服务留空目标主机即可，不能把远端 loopback 当作入口本机');
}
