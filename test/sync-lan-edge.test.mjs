import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSync, mergeChanges} from '../scripts/sync-lan-edge.mjs';

const device = (id, address) => ({id, address});

test('只同步 lyokm.cn 下的 HTTP 站点，跳过 TCP 与其他域名', () => {
  const {desired, skipped} = planSync({
    services: [
      {alias: 'tc', port: 8111, deviceId: 'd1', scheme: 'http'},
      {alias: 'pg', port: 5432, deviceId: 'd1', scheme: 'tcp'},
      {alias: 'company-ai', port: 18080, deviceId: 'd1', domain: 'addzero.site'},
      {alias: 'readonly', port: 80, deviceId: 'd1', readOnly: true},
    ],
    devices: [device('d1', '10.144.144.1')],
    suffix: 'lyokm.cn',
    aliases: [],
  });
  assert.deepEqual([...desired.keys()], ['tc']);
  assert.equal(desired.get('tc').host, '127.0.0.1');
  assert.equal(desired.get('tc').visibility, 'internal');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /company-ai/);
});

test('设备自身的 EasyTier 地址被保留，未被登记的别名算新增', () => {
  const {changes} = planSync({
    services: [{alias: 'tianjin-web', port: 80, deviceId: 'd2'}],
    devices: [device('d2', '10.144.144.98')],
    suffix: 'lyokm.cn',
    aliases: [],
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, '新增');
  assert.equal(changes[0].want.host, '10.144.144.98');
  assert.equal(changes[0].want.scheme, 'http');
});

test('已一致的条目不产生差异（幂等）', () => {
  const aliases = [{alias: 'tc', host: '127.0.0.1', port: 8111, scheme: 'http', visibility: 'internal', disabled: false}];
  const {changes} = planSync({
    services: [{alias: 'tc', port: 8111, deviceId: 'd1'}],
    devices: [device('d1', '10.144.144.1')],
    suffix: 'lyokm.cn',
    aliases,
  });
  assert.deepEqual(changes, []);
});

test('public 条目同步时带上授权人，否则 aio-portal 的策略校验会拒绝整次 sync', () => {
  const {desired} = planSync({
    services: [
      {alias: 'tc', port: 8111, deviceId: 'd1', visibility: 'public'},
      {alias: 'dev', port: 48090, deviceId: 'd1', visibility: 'internal'},
    ],
    devices: [device('d1', '10.144.144.1')],
    suffix: 'lyokm.cn',
    aliases: [],
  });
  assert.equal(desired.get('tc').authorizedBy, 'tunnel-console');
  assert.equal(desired.get('dev').authorizedBy, undefined);
});

test('public 条目缺少授权人时算差异，用于补齐老登记', () => {
  const aliases = [{alias: 'tc', host: '127.0.0.1', port: 8111, scheme: 'http', visibility: 'public', disabled: false}];
  const plan = planSync({
    services: [{alias: 'tc', port: 8111, deviceId: 'd1', visibility: 'public'}],
    devices: [device('d1', '10.144.144.1')],
    suffix: 'lyokm.cn',
    aliases,
  });
  assert.equal(plan.changes.length, 1);
  assert.equal(mergeChanges(plan.existing, plan.changes)[0].authorizedBy, 'tunnel-console');
});

test('182 侧手工 disable 的条目保持停用，不会被定时器重新启用', () => {
  const aliases = [{alias: 's3', host: '127.0.0.1', port: 9900, scheme: 'http', visibility: 'internal', disabled: true}];
  const plan = planSync({
    services: [{alias: 's3', port: 9900, deviceId: 'd1'}],
    devices: [device('d1', '10.144.144.1')],
    suffix: 'lyokm.cn',
    aliases,
  });
  assert.deepEqual(plan.changes, [], '已停用的条目不能被写回 disabled:false');
  assert.deepEqual(plan.disabled, ['s3']);
  assert.equal(mergeChanges(plan.existing, plan.changes)[0].disabled, true);
});

test('端口变化算更新，合并时保留非 tunnel 字段', () => {
  const aliases = [{alias: 'tc', host: '127.0.0.1', port: 8110, scheme: 'http', visibility: 'internal', authorizedBy: 'tester'}];
  const plan = planSync({
    services: [{alias: 'tc', port: 8111, deviceId: 'd1'}],
    devices: [device('d1', '10.144.144.1')],
    suffix: 'lyokm.cn',
    aliases,
  });
  assert.equal(plan.changes[0].kind, '更新');
  const merged = mergeChanges(plan.existing, plan.changes);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].port, 8111);
  assert.equal(merged[0].authorizedBy, 'tester');
});

test('未绑定 EasyTier 地址的设备被跳过而不是写空 host', () => {
  const {desired, skipped} = planSync({
    services: [{alias: 'ghost', port: 80, deviceId: 'missing'}],
    devices: [],
    suffix: 'lyokm.cn',
    aliases: [],
  });
  assert.equal(desired.size, 0);
  assert.match(skipped[0], /未绑定/);
});

test('public 服务同步为 public，不能被降级成 internal（否则公网命中白名单被 404）', () => {
  const {desired, changes} = planSync({
    services: [{alias: 'tianjin-web', port: 80, deviceId: 'd2', visibility: 'public'}],
    devices: [device('d2', '10.144.144.98')],
    suffix: 'lyokm.cn',
    aliases: [{alias: 'tianjin-web', host: '10.144.144.98', port: 80, scheme: 'http', visibility: 'internal', lan: true}],
  });
  assert.equal(desired.get('tianjin-web').visibility, 'public');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, '更新');
  assert.equal(changes[0].want.visibility, 'public');
});

test('public 与 internal 的可见性差异本身即可触发同步', () => {
  const {changes} = planSync({
    services: [{alias: 'tj-web', port: 80, deviceId: 'd2', visibility: 'public'}],
    devices: [device('d2', '10.144.144.98')],
    suffix: 'lyokm.cn',
    aliases: [{alias: 'tj-web', host: '10.144.144.98', port: 80, scheme: 'http', visibility: 'internal'}],
  });
  assert.equal(changes[0].want.visibility, 'public');
});
