import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

// 仅本地临时 / CI-only：固定校验和的官方二进制只用于测试，不部署任何常驻服务。
if (process.platform !== 'linux' || process.arch !== 'x64') { throw new Error('FRP 集成测试需要 Linux x64'); }
const version = '0.71.1';
const digest = '1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803';
const directory = mkdtempSync(join(tmpdir(), 'tunnel-frp-tools-'));
let exitCode = 1;
try {
  const name = `frp_${version}_linux_amd64`;
  const archive = join(directory, 'frp.tar.gz');
  if (process.env.FRP_TEST_ARCHIVE) { copyFileSync(process.env.FRP_TEST_ARCHIVE, archive); }
  else { execFileSync('curl', ['-4', '--fail', '--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '10', '--max-time', '60', '--output', archive, `https://github.com/fatedier/frp/releases/download/v${version}/${name}.tar.gz`], {stdio:'inherit'}); }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== digest) { throw new Error('FRP 二进制校验和不匹配'); }
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  const result = spawnSync('npm', ['test'], {stdio:'inherit', env:{...process.env, FRP_TEST_BIN_DIR:join(directory, name)}});
  exitCode = result.status ?? 1;
} finally { rmSync(directory, {recursive:true, force:true}); }
process.exitCode = exitCode;
