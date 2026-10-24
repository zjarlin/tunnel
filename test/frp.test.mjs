import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

async function listen(server, host = '127.0.0.1', port = 0) {
  server.listen(port, host);
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { return; }
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  await ended;
}
async function until(check) {
  let failure;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await check(); } catch (error) { failure = error; }
    await delay(100);
  }
  throw failure;
}

test('real FRP forwarding, old-client persistence and private-listener enforcement', {skip:!process.env.FRP_TEST_BIN_DIR, timeout:45000}, async t => {
  // 临时原生进程、随机端口和目录；退出时仅清理本测试拥有的资源。
  const root = mkdtempSync(join(tmpdir(), 'tunnel-frp-test-'));
  const servers = [], children = [];
  const overrides = {TUNNEL_PUBLIC_URL:'http://127.0.0.1', TUNNEL_AIO_DATABASE_URL:'', TUNNEL_ACME_DIRECTORY:'', TUNNEL_CADDY_LISTENER:'', TUNNEL_CADDY_INSTANCES:'1', TUNNEL_VERIFY_UPSTREAM:'0'};
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(async () => {
    for (const child of children.reverse()) { await stop(child); }
    for (const server of servers) { await close(server); }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
    rmSync(root, {recursive:true, force:true});
  });
  await build({entryPoints:['src/server/services.ts'],outfile:join(root,'services.mjs'),bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
  const {serviceRegistry} = await import(pathToFileURL(join(root,'services.mjs')));
  const upstream = createServer((req,res) => res.end(`real-frp-origin:${req.url}`));
  servers.push(upstream);
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const controlPort = await listen(reservation);
  const forwardReservation = createServer();
  const forwardPort = await listen(forwardReservation);
  await close(forwardReservation);
  await close(reservation);
  const token = randomUUID();
  const frpsConfig = join(root,'frps.json');
  const frpcConfig = join(root,'frpc.json');
  writeFileSync(frpsConfig,JSON.stringify({bindAddr:'127.0.0.1',bindPort:controlPort,proxyBindAddr:'127.0.0.1',auth:{method:'token',token},transport:{tls:{force:true}},allowPorts:[{single:forwardPort}],log:{to:join(root,'frps.log'),level:'warn'}}),{mode:0o600});
  writeFileSync(frpcConfig,JSON.stringify({serverAddr:'127.0.0.1',serverPort:controlPort,auth:{method:'token',token},transport:{tls:{enable:true}},proxies:[{name:`tmp-${randomUUID()}`,type:'tcp',localIP:'127.0.0.1',localPort:upstreamPort,remotePort:forwardPort}],log:{to:join(root,'frpc.log'),level:'warn'}}),{mode:0o600});
  function start(binary, config) {
    const child = spawn(join(process.env.FRP_TEST_BIN_DIR,binary),['-c',config],{stdio:['ignore','ignore','inherit']});
    children.push(child);
    return child;
  }
  const frps = start('frps',frpsConfig);
  await until(() => new Promise((resolve,reject) => {
    const socket = connect({host:'127.0.0.1',port:controlPort});
    socket.once('connect',() => { socket.destroy(); resolve(); });
    socket.once('error',reject);
  }));
  const frpc = start('frpc',frpcConfig);
  const origin = `http://127.0.0.1:${forwardPort}`;
  await until(async () => assert.equal(await (await fetch(`${origin}/probe`,{signal:AbortSignal.timeout(500)})).text(),'real-frp-origin:/probe'));
  const changes = [];
  let configuration = {apps:{http:{servers:{test:{routes:[{match:[{host:['127.0.0.1']}]}]}}}}};
  const caddy = createServer(async (req,res) => {
    if (req.method === 'POST') {
      let text = ''; for await (const chunk of req) { text += chunk; }
      configuration = JSON.parse(text);changes.push(configuration);
    }
    res.setHeader('etag','"/config/ frp-test"');res.end(JSON.stringify(configuration));
  });
  servers.push(caddy);
  const caddyPort = await listen(caddy);
  const settings = {suffix:'example.test',lanIp:'127.0.0.1',portal:{root},caddy:{allow:['127.0.0.1/32']}};
  const registry = serviceRegistry(settings,`http://127.0.0.1:${caddyPort}`);
  const item = {alias:'private',host:'127.0.0.1',port:forwardPort,scheme:'http',visibility:'internal',transport:'frp',note:''};
  registry.save(item);
  assert.equal((await registry.apply()).state,'success');
  assert.match(JSON.stringify(changes.at(-1)),new RegExp(`127\\.0\\.0\\.1:${forwardPort}`));
  assert.match(JSON.stringify(changes.at(-1)),/"remote_ip"/);
  assert.match(JSON.stringify(changes.at(-1)),/"status_code":404/);
  registry.save({...item,scheme:'https',tlsServerName:'origin.example.test'});
  await registry.apply();
  assert.match(JSON.stringify(changes.at(-1)),/"server_name":"origin.example.test"/);
  assert.ok(!JSON.stringify(changes.at(-1)).includes('insecure_skip_verify'));
  registry.save(item);
  await registry.apply();
  const {transport,...oldClient} = item;
  registry.save({...oldClient,note:'edited by previous UI'});
  assert.equal(registry.list()[0].transport,'frp');
  await stop(frpc);await stop(frps);
  const changesBeforeFailure = changes.length;
  await assert.rejects(registry.apply(),/FRP 映射端口未监听/);
  assert.equal(changes.length,changesBeforeFailure);
  const exposed = createServer((req,res) => res.end('unsafe-listener'));
  servers.push(exposed);await listen(exposed,'0.0.0.0',forwardPort);
  await assert.rejects(registry.apply(),/非回环监听/);
  await assert.rejects(registry.recover(),/非回环监听/);
  assert.ok(!JSON.stringify(configuration).includes('private.example.test'),'Recovery must remove an unsafe private mapping');
  await close(exposed);
  start('frps',frpsConfig);
  await until(() => new Promise((resolve,reject) => {
    const socket = connect({host:'127.0.0.1',port:controlPort});
    socket.once('connect',() => { socket.destroy(); resolve(); });
    socket.once('error',reject);
  }));
  start('frpc',frpcConfig);
  await until(async () => assert.equal(await (await fetch(`${origin}/restored`,{signal:AbortSignal.timeout(500)})).text(),'real-frp-origin:/restored'));
  await registry.recover();
  assert.ok(JSON.stringify(configuration).includes('private.example.test'));
  registry.remove(item.alias);await registry.apply();
  assert.equal(await (await fetch(`${origin}/retained`)).text(),'real-frp-origin:/retained','Deleting the portal must preserve the external FRP mapping');
});
