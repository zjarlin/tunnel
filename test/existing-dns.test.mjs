import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('existing public DNS stays untouched and detects changes before applying', async t => {
  const root = mkdtempSync(join(tmpdir(),'tunnel-existing-dns-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  await build({entryPoints:['src/server/cloud-dns.ts'],outfile:join(root,'dns.mjs'),bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
  const {dnsPlan} = await import(pathToFileURL(join(root,'dns.mjs')));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let records = [{id:'external',type:'CNAME',content:'connector.example.test',comment:'existing-ingress',proxied:true}];
  const requests = [];
  globalThis.fetch = async (_url,options) => {
    requests.push(options.method);
    return {ok:true,json:async () => ({success:true,result:records})};
  };
  const account = {provider:'cloudflare',domain:'example.test',zone:'test-zone',key:'fake-token',secret:'',rawHost:'raw.example.test'};
  const plan = await dnsPlan(account,'mobile.example.test','public','existing');
  await plan.apply();
  assert.deepEqual(new Set(requests),new Set(['GET']));
  assert.equal(records[0].proxied,true);
  records = [{...records[0],proxied:false}];
  await assert.rejects(plan.apply(),/已变化/);
  records = [{...records[0],proxied:true}];
  await assert.rejects(dnsPlan(account,'mobile.example.test','internal','existing'),/仅适用于公网/);
  await assert.rejects(dnsPlan(account,'mobile.example.test','public'),/其他系统/);
  records = [{...records[0],content:'changed.example.test'}];
  await assert.rejects(plan.apply(),/已变化/);
  records = [];
  await assert.rejects(dnsPlan(account,'mobile.example.test','public','existing'),/没有可保留/);
  assert.ok(requests.every(method => method === 'GET'));
});
