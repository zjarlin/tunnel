import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveHost} from '../dist/targets.mjs';

const device = 'okm182';

test('没绑设备时目标主机就是最终地址', () => {
  assert.equal(resolveHost({host: '10.144.144.98'}, device, '10.144.144.1'), '10.144.144.98');
});

test('绑了设备但目标留空时用设备自己的中继地址', () => {
  assert.equal(resolveHost({deviceId: device}, device, '10.144.144.1'), '10.144.144.1');
});

test('目标就是发布节点本机时保留 127.0.0.1，不换成中继地址', () => {
  assert.equal(resolveHost({deviceId: device, host: '127.0.0.1'}, device, '10.144.144.1'), '127.0.0.1');
  assert.equal(resolveHost({deviceId: device, host: 'localhost'}, device, '10.144.144.1'), '127.0.0.1');
});

test('别的设备的回环不能当入口本机，直接报错而不是探测错地址', () => {
  assert.throws(() => resolveHost({deviceId: 'macbook', host: '127.0.0.1'}, device, '10.144.144.5'), /远端 loopback/);
  assert.throws(() => resolveHost({deviceId: 'macbook', host: '127.0.0.1'}, undefined, '10.144.144.5'), /远端 loopback/);
});

test('绑了设备又填了显式目标时按填写的目标走', () => {
  assert.equal(resolveHost({deviceId: device, host: '192.168.31.250'}, device, '10.144.144.1'), '192.168.31.250');
});
