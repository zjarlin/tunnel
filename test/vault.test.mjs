import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

async function load(t) {
  const root = mkdtempSync(join(tmpdir(), 'tunnel-vault-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  await build({entryPoints: ['src/server/vault.ts'], outfile: join(root, 'vault.mjs'), bundle: true, platform: 'node', format: 'esm'});
  const {vault} = await import(pathToFileURL(join(root, 'vault.mjs')));
  process.env.TUNNEL_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  return {root, vault};
}

test('密码本加密落盘，列表不返回口令，留空编辑保留原密码', async t => {
  const {root, vault} = await load(t);
  const book = vault(root);
  const entry = book.save({name: '天津 PostgreSQL', category: '数据库', url: 'raw.lyokm.cn:5432', username: 'okm_iot', password: 'p@ss-unique-9281', note: '天津业务库'});
  assert.equal(entry.hasPassword, true);
  assert.equal(entry.passwordLength, 'p@ss-unique-9281'.length);
  assert.equal('password' in entry, false);

  const file = join(root, 'vault.enc');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file).includes(Buffer.from('p@ss-unique-9281')), false);
  // 条目名同样在密文里，不应明文落盘。
  assert.equal(readFileSync(file).includes(Buffer.from('天津 PostgreSQL')), false);

  const listed = book.list();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes('p@ss-unique-9281'), false);
  assert.equal(book.reveal(entry.id).password, 'p@ss-unique-9281');

  book.save({id: entry.id, name: '天津 PostgreSQL（改名）', category: '数据库', url: 'raw.lyokm.cn:5432', username: 'okm_iot', password: '', note: ''});
  assert.equal(book.reveal(entry.id).password, 'p@ss-unique-9281');
  assert.equal(book.list()[0].name, '天津 PostgreSQL（改名）');

  book.save({id: entry.id, name: '天津 PostgreSQL', category: '数据库', url: 'raw.lyokm.cn:5432', username: 'okm_iot', password: 'rotated-5510', note: ''});
  assert.equal(book.reveal(entry.id).password, 'rotated-5510');

  assert.throws(() => book.save({name: '', password: 'x'}), /请填写名称/);
  assert.throws(() => book.save({name: '空密码'}), /请填写密码/);
  assert.throws(() => book.reveal('missing'), /不存在/);

  book.remove(entry.id);
  assert.equal(book.list().length, 0);
  assert.throws(() => book.remove(entry.id), /不存在/);
});

test('密码本拒绝被篡改的密文与错误密钥', async t => {
  const {root, vault} = await load(t);
  const book = vault(root);
  const entry = book.save({name: 'Redis', category: '中间件', url: 'raw.lyokm.cn:6379', username: 'default', password: 'redis-secret', note: ''});
  assert.equal(book.reveal(entry.id).password, 'redis-secret');

  const file = join(root, 'vault.enc');
  const bytes = readFileSync(file);
  bytes[30] ^= 1;
  writeFileSync(file, bytes);
  assert.throws(() => book.list());

  const {root: other, vault: fresh} = await load(t);
  const rotated = fresh(other);
  rotated.save({name: 'MinIO', password: 'minio-secret'});
  process.env.TUNNEL_SECRET_KEY = Buffer.alloc(32, 8).toString('base64');
  assert.throws(() => rotated.list());
  process.env.TUNNEL_SECRET_KEY = '';
  assert.throws(() => rotated.list(), /32 字节/);
});
