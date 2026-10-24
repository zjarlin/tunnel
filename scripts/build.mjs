import {build} from 'esbuild';
import {readFile,chmod,cp,mkdir} from 'node:fs/promises';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await build({entryPoints:['src/cli.ts'],bundle:true,platform:'node',target:'node22',format:'esm',outfile:'dist/cli.mjs',define:{PACKAGE_VERSION:JSON.stringify(version)}});
await chmod('dist/cli.mjs',0o755);
await build({entryPoints:['src/server/main.ts'],bundle:true,platform:'node',target:'node22',format:'esm',outfile:'dist/server.mjs'});
await build({entryPoints:['src/aio/sidecar.ts'],bundle:true,platform:'node',target:'node22',format:'esm',outfile:'dist/sidecar.mjs'});
await mkdir('dist/web',{recursive:true});
await cp('web','dist/web',{recursive:true});
