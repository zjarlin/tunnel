import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';

test('issued certificates override cached internal issuers without changing unrelated TLS policies',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tunnel-certificate-'));
  const original=process.env.TUNNEL_PUBLIC_URL;
  process.env.TUNNEL_PUBLIC_URL='https://console.example.test';
  const unrelated={match:{sni:['other.example.test']},certificate_selection:{any_tag:['other']}};
  let config={apps:{http:{servers:{web:{listen:[':443'],routes:[{match:[{host:['console.example.test']}]}],tls_connection_policies:[unrelated,{}]}}}}};
  let updates=0;
  const server=createServer(async(req,res)=>{
    if(req.method==='POST'){
      let text='';for await(const chunk of req){text+=chunk;}
      config=JSON.parse(text);updates++;
    }
    res.setHeader('etag','"/config/ certificate-test"');res.end(JSON.stringify(config));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});
    if(original===undefined){delete process.env.TUNNEL_PUBLIC_URL;}else{process.env.TUNNEL_PUBLIC_URL=original;}
  });
  await build({entryPoints:['src/server/caddy.ts'],outfile:join(root,'caddy.mjs'),bundle:true,platform:'node',format:'esm'});
  const {publish}=await import(pathToFileURL(join(root,'caddy.mjs')));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  const settings={suffix:'example.test',caddy:{allow:['127.0.0.1/32']}};
  const alias={alias:'storage',host:'127.0.0.1',port:9000,scheme:'http',visibility:'internal'};
  const certificate={certificate:'test-pem',key:'test-key',tags:['tunnel-service:storage.example.test']};
  await publish(settings,[alias],endpoint,[certificate]);
  assert.deepEqual(config.apps.http.servers.web.tls_connection_policies,[{match:{sni:['storage.example.test']},certificate_selection:{any_tag:certificate.tags}},unrelated,{}]);
  assert.ok(!config.apps.tls.automation.policies.some(policy=>policy.subjects?.includes('storage.example.test')));
  await publish(settings,[alias],endpoint,[certificate]);assert.equal(updates,1);
  await publish(settings,[],endpoint,[]);
  assert.deepEqual(config.apps.http.servers.web.tls_connection_policies,[unrelated,{}]);
});
