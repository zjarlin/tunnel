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
// 独立控制台：web/ 只留 HTML 与样式，app.js 由 web-src/shell.ts 构建（面板与 AIO 页共用同一份源码）。
await build({bundle:true,platform:'browser',target:'es2022',format:'esm',entryPoints:['web-src/shell.ts'],outfile:'dist/web/app.js',minify:true,charset:'utf8'});
await cp('web/index.html','dist/web/index.html');
await cp('web/style.css','dist/web/style.css');
