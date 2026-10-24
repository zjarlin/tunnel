import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

test('cloud credentials remain encrypted, survive updates, and never appear in account lists', async t => {
  const root = mkdtempSync(join(tmpdir(),'tunnel-credentials-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  await build({entryPoints:['src/server/accounts.ts'],outfile:join(root,'accounts.mjs'),bundle:true,platform:'node',format:'esm'});
  const {accounts} = await import(pathToFileURL(join(root,'accounts.mjs')));
  process.env.TUNNEL_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
  const store = accounts(root);
  const account = {id:'cloud',label:'云账号',provider:'huawei',domain:'example.test',zone:'',rawHost:'raw.example.test',key:'test-ak-unique',secret:'test-sk-unique'};
  store.save(account);
  assert.equal(store.get('cloud').secret,account.secret);
  assert.equal(JSON.stringify(store.list()).includes(account.secret),false);
  assert.equal(JSON.stringify(store.list()).includes(account.key),false);
  assert.equal(readFileSync(join(root,'accounts.enc')).includes(Buffer.from(account.secret)),false);
  store.save({...account,label:'新名称',key:'',secret:''});
  assert.equal(store.get('cloud').secret,account.secret);
  assert.throws(() => store.save({...account,rawHost:'home.example.test'}));
  const bytes=readFileSync(join(root,'accounts.enc')); bytes[28]^=1;
  const {writeFileSync}=await import('node:fs'); writeFileSync(join(root,'accounts.enc'),bytes);
  assert.throws(() => store.list(), /authenticate/);
});
