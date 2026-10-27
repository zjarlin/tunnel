import {build} from 'esbuild';
import {readFile,chmod,cp,mkdir} from 'node:fs/promises';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const banner={js:"import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"};
await build({entryPoints:['src/cli.ts'],bundle:true,platform:'node',target:'node22',format:'esm',outfile:'dist/cli.mjs',define:{PACKAGE_VERSION:JSON.stringify(version)},banner});
await chmod('dist/cli.mjs',0o755);
const runtime = {bundle:true,platform:'node',target:'node22',format:'esm',minify:true,legalComments:'none',banner:{js:"import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"}};
await build({...runtime,entryPoints:['src/server/main.ts'],outfile:'dist/server.mjs'});
await build({...runtime,entryPoints:['src/aio/sidecar.ts'],outfile:'dist/sidecar.mjs'});
// 可单测的纯逻辑入口（不启服务）：发布节点绑定与注册表格式化。
await build({...runtime, entryPoints:['src/server/bindings.ts'], outfile:'dist/bindings.mjs'});
await build({...runtime, entryPoints:['src/server/targets.ts'], outfile:'dist/targets.mjs'});
await mkdir('dist/web',{recursive:true});
await cp('web','dist/web',{recursive:true});
