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
