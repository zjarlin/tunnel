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

test('locates the managed server without relying on the console hostname',async t=>{
  // 控制台 tunnel.addzero.site 下线后，publish 不能再靠它的域名认 server；
  // 否则 25 条生产路由（含 company-ai -> sub2api）会整体发布失败。
  const {build}=await import('esbuild');
  const root=mkdtempSync(join(tmpdir(),'tunnel-locate-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  await build({entryPoints:['src/server/caddy.ts'],outfile:join(root,'caddy.mjs'),bundle:true,platform:'node',format:'esm'});
  const {locate}=await import(pathToFileURL(join(root,'caddy.mjs')));
  const settings={suffix:'example.test'};
  const config={apps:{http:{servers:{web:{listen:[':443'],routes:[{match:[{host:['existing.example.test']}]}]}}}}};
  const originalHosts=process.env.TUNNEL_CADDY_HOSTS;
  const originalUrl=process.env.TUNNEL_PUBLIC_URL;
  t.after(()=>{
    if(originalHosts===undefined){delete process.env.TUNNEL_CADDY_HOSTS;}else{process.env.TUNNEL_CADDY_HOSTS=originalHosts;}
    if(originalUrl===undefined){delete process.env.TUNNEL_PUBLIC_URL;}else{process.env.TUNNEL_PUBLIC_URL=originalUrl;}
  });
  // 控制台已下线且没有显式线索：不应认领任何 server，避免误改别人的配置。
  delete process.env.TUNNEL_CADDY_HOSTS;delete process.env.TUNNEL_PUBLIC_URL;
  assert.equal(locate(settings,[],config,':443').length,0);
  // 显式声明该实例承载的既有站点名即可定位。
  process.env.TUNNEL_CADDY_HOSTS='existing.example.test';
  assert.deepEqual(locate(settings,[],config,':443').map(([name])=>name),['web']);
  // 已接管的 server 在别名清空后仍要被认领，否则最后一条登记删不掉旧路由。
  const managed={apps:{http:{servers:{web:{listen:[':443'],routes:[{'@id':'tunnel-services-web',handle:[]}]}}}}};
  delete process.env.TUNNEL_CADDY_HOSTS;
  assert.deepEqual(locate(settings,[],managed,':443').map(([name])=>name),['web']);
});
