# 构建脚本

`build.mjs` 用 esbuild 把 `src/cli.ts` 打包成 `dist/cli.mjs` 并设为可执行。

`dist/` 已随仓库提交，因此 `npm install --global git+https://…` 这类 GitHub 安装方式
无需在安装时下载 esbuild 或执行构建即可直接使用；日常开发仍执行 `npm run build`。
修改源码后必须重新构建并一起提交，保持 `dist/cli.mjs` 与源码一致。

`issue-certificate.mjs` 为单个域名签发并落盘证书；`sync-lan-edge.mjs` 把 tunnel 控制台
已登记的服务单向同步成 182 内网入口（`aio-portal` 注册表 + dnsmasq/localmesh Caddy），
由 systemd `tunnel-lan-edge.timer` 每 5 分钟跑一次：

```bash
TUNNEL_API_TOKEN=... node scripts/sync-lan-edge.mjs --dry-run   # 只看差异
```

它只增改 tunnel 名下的同名别名，不删条目、不动 182 本机自有站点（fire/hifly/nacos 等）；
TCP 入口与其他域名（`addzero.site`）不在此同步范围内。
