import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:http';
import {once} from 'node:events';
import {gunzipSync} from 'node:zlib';

test('native AIO package embeds an ELF sidecar that serves the process contract',async t=>{
  execFileSync(process.execPath,['scripts/package-aio.mjs'],{env:{...process.env,TUNNEL_NODE_IMAGE:`node@sha256:${'a'.repeat(64)}`,TUNNEL_AIO_ENDPOINT:'http://127.0.0.1:3180/api/aio'}});
  const bundle=JSON.parse(gunzipSync(readFileSync('dist/tunnel.aio-plugin')));
  assert.match(bundle.manifest,/artifact = "dist\/aio-sidecar"/);
  assert.equal(Buffer.from(bundle.files['dist/aio-sidecar'],'base64').subarray(0,6).toString('hex'),'7f454c460201');
  const root=mkdtempSync(join(tmpdir(),'tunnel-native-'));const socket=join(root,'service.sock');
  writeFileSync(join(root,'config.json'),JSON.stringify({tenant_id:'test',ingress_token:'test-token'}));
  const child=spawn('./dist/aio-sidecar',[],{env:{...process.env,AIO_PLUGIN_CONFIG:join(root,'config.json'),AIO_PLUGIN_SOCKET:socket},stdio:['ignore','pipe','pipe']});
  t.after(()=>{child.kill();rmSync(root,{recursive:true,force:true});});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw new Error(`ELF sidecar exited ${code}`);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('ELF startup timeout')),10000);timer.unref();})]);
  const response=await new Promise((resolve,reject)=>{const call=request({socketPath:socket,path:'/aio/describe'},res=>{let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve(JSON.parse(text)));});call.on('error',reject);call.end();});
  assert.equal(response.pages[0].label,'服务入口');
});
