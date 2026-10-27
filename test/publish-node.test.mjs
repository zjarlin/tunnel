import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeBindings, publishBinding, readBindings, setBinding} from '../dist/bindings.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'tunnel-publish-'));

test('历史字符串格式被归一成对象，读入不报错也不丢数据', () => {
  const dir = root();
  writeFileSync(join(dir, 'devices.json'), JSON.stringify({'dev-1': '10.144.144.1'}));
  assert.deepEqual(readBindings(dir), {'dev-1': {address: '10.144.144.1'}});
});

test('设为发布节点后全机唯一：再设另一台会顶替上一台', () => {
  const dir = root();
  setBinding(dir, 'okm182', {address: '10.144.144.1', role: 'publish'});
  setBinding(dir, 'macbook', {address: '10.144.144.5', role: 'publish'});
  const bindings = readBindings(dir);
  assert.equal(bindings.okm182.role, undefined, '上一台必须交出发布角色');
  assert.equal(bindings.okm182.address, '10.144.144.1', '取消角色不能连地址一起丢');
  assert.equal(bindings.macbook.role, 'publish');
  assert.deepEqual(publishBinding(bindings), {id: 'macbook', address: '10.144.144.5'});
});

test('取消发布节点后没有发布出口，且地址保持', () => {
  const dir = root();
  setBinding(dir, 'okm182', {address: '10.144.144.1', role: 'publish'});
  setBinding(dir, 'okm182', {role: null});
  assert.equal(publishBinding(readBindings(dir)), undefined);
  assert.equal(readBindings(dir).okm182.address, '10.144.144.1');
});

test('清空地址后条目保留角色，条目不会凭空消失', () => {
  const dir = root();
  setBinding(dir, 'okm182', {address: '10.144.144.1', role: 'publish'});
  setBinding(dir, 'okm182', {address: null});
  const bindings = readBindings(dir);
  assert.equal(bindings.okm182.address, undefined);
  assert.equal(bindings.okm182.role, 'publish', '只清地址不应摘掉发布角色');
});

test('无地址无角色的空条目被删掉，不留垃圾行', () => {
  const dir = root();
  setBinding(dir, 'okm182', {address: '10.144.144.1'});
  setBinding(dir, 'okm182', {address: null});
  assert.deepEqual(readBindings(dir), {});
});

test('绑定文件 0600，写盘用 rename 不留半截文件', () => {
  const dir = root();
  setBinding(dir, 'okm182', {address: '10.144.144.1', role: 'publish'});
  const file = join(dir, 'devices.json');
  if (process.platform !== 'win32') { assert.equal(statSync(file).mode & 0o777, 0o600); }
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
});

test('归一化拒绝非法形状，不把脏数据带进发布流程', () => {
  assert.deepEqual(normalizeBindings(null), {});
  assert.deepEqual(normalizeBindings({a: 42, b: {}, c: {role: 'other'}}), {});
  assert.deepEqual(normalizeBindings({d: {address: 'x', role: 'publish'}}), {d: {address: 'x', role: 'publish'}});
});
