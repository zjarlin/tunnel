import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('DNS challenge preserves foreign TXT records and removes only its own proof',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tunnel-challenge-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  await build({entryPoints:['src/server/cloud-dns.ts'],outfile:join(root,'dns.mjs'),bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
  const {dnsChallenge}=await import(pathToFileURL(join(root,'dns.mjs')));
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let records=[{id:'foreign',type:'TXT',content:'other-proof',comment:'other-client'}];
  const writes=[];
  globalThis.fetch=async(_url,options)=>{
    if(options.method==='GET'){return {ok:true,json:async()=>({success:true,result:records})};}
    writes.push(options.method);
    if(options.method==='DELETE'){records=[];}
    else {records=[{id:'managed',...JSON.parse(options.body)}];}
    return {ok:true,json:async()=>({success:true,result:{}})};
  };
  const account={provider:'cloudflare',domain:'example.test',zone:'test-zone',key:'fake-token',secret:''};
  await assert.rejects(dnsChallenge(account,'service.example.test','proof'),/其他证书工具/);
  assert.equal(writes.length,0);
  records=[];
  const cleanup=await dnsChallenge(account,'service.example.test','proof');
  assert.equal(records[0].type,'TXT');
  assert.equal(records[0].name,'_acme-challenge.service.example.test');
  await cleanup();assert.equal(records.length,0);
  const next=await dnsChallenge(account,'service.example.test','proof');
  records[0].content='replaced-proof';
  await next();assert.equal(records.length,1);
  await assert.rejects(dnsChallenge(account,'foreign.invalid','proof'),/不属于/);
});
