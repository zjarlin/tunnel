import {readFileSync,writeFileSync,mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

/** 宿主 v2 仅接受 ELF；将已打包脚本嵌入可执行产物，复用批准镜像中的 Node。 */
export function sidecarExecutable() {
  if(process.platform !== 'linux' || process.arch !== 'x64') { throw new Error('AIO process packaging requires Linux x64'); }
  const directory=mkdtempSync(join(tmpdir(),'tunnel-elf-'));
  try {
    const script=readFileSync('dist/sidecar.mjs');
    const source=`#define _GNU_SOURCE
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
static const unsigned char script[] = {${[...script].join(',')}};
int main(void) {
  int fd=memfd_create("tunnel-sidecar",0);
  if(fd<0) { perror("memfd_create"); return 1; }
  size_t offset=0;
  while(offset<sizeof(script)) { ssize_t n=write(fd,script+offset,sizeof(script)-offset); if(n<=0) { perror("write"); return 1; } offset+=(size_t)n; }
  if(lseek(fd,0,SEEK_SET)<0 || dup2(fd,STDIN_FILENO)<0) { perror("stdin"); return 1; }
  close(fd);
  execlp("node","node","--input-type=module",(char*)NULL);
  perror("node"); return 1;
}
`;
    const path=join(directory,'sidecar.c');writeFileSync(path,source);
    execFileSync('gcc',['-Os','-s','-Wl,-z,relro,-z,now',path,'-o',resolve('dist/aio-sidecar')]);
    chmodSync('dist/aio-sidecar',0o755);
    return 'dist/aio-sidecar';
  } finally { rmSync(directory,{recursive:true,force:true}); }
}
