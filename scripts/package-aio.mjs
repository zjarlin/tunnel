import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {sidecarExecutable} from './sidecar-executable.mjs';
const executable=sidecarExecutable();
const required = name => { if (!process.env[name]) { throw new Error(`${name} is required`); } return process.env[name]; };
const endpoint = required('TUNNEL_AIO_ENDPOINT');
const image = required('TUNNEL_NODE_IMAGE');
const manifest = `schema_version = 2
[plugin.marketplace]
title = "服务入口"
summary = "配对设备、内网地址、DNS 服务商与访问范围：一台发布节点把服务公开到公网"
license = "MIT"
tags = ["网络", "设备", "DNS"]
[plugin.runtime]
artifact = "dist/aio-sidecar"
host_version = ">=2026.10.17"
[plugin.runtime.process]
image = ${JSON.stringify(image)}
http_endpoints = [${JSON.stringify(endpoint)}]
[plugin.frontend]
path = "dist/web"
[plugin.database]
migrations = "migrations"
[plugin.capabilities]
database = true
cryptography = true
`;
const paths = [executable, ...readdirSync('dist/web').filter(file => file !== 'README.md').map(file => `dist/web/${file}`), ...readdirSync('migrations').map(file => `migrations/${file}`)].sort();
const bundle = {abi_version:2, git:'https://github.com/zjarlin/tunnel.git', commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), version:JSON.parse(readFileSync('package.json')).version, manifest, files:Object.fromEntries(paths.map(path => [path,readFileSync(path).toString('base64')])), digest:''};
const hash = createHash('sha256').update('aio:plugin@2.0.0/bundle\0').update(Buffer.from([0,0,0,2]));
function field(value) { const bytes = Buffer.from(value); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes); }
for (const value of [bundle.git,bundle.commit,bundle.version,bundle.manifest]) { field(value); }
for (const [path,data] of Object.entries(bundle.files)) { field(path); field(data); }
bundle.digest = hash.digest('hex');
writeFileSync('dist/tunnel.aio-plugin', gzipSync(JSON.stringify(bundle)));
writeFileSync('dist/aio-manifest.toml', manifest);
console.log(JSON.stringify({file:'dist/tunnel.aio-plugin',digest:bundle.digest,commit:bundle.commit}));
