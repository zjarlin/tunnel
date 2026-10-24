# Tunnel

独立部署的服务入口控制台。通过表格登记域名别名、目标主机、端口和访问范围，复用 Caddy 与现有 EasyTier 网络。AIO 可通过 sidecar 接入同一个 API；独立服务不依赖 AIO 或 PostgreSQL。

本项目从 [aio-plugin-portal](https://github.com/org-aio/aio-plugin-portal) 保留 Git 历史演进而来。DNS provider 与 CLI 代码在这里继续维护；AIO 适配只承担身份校验和 API 转发。

## Docker Compose

使用官方 Node 镜像，无 Dockerfile，不启动额外数据库或 Caddy。

```sh
npm ci
npm test
DEPLOY_DIR="$HOME/DockerCompose/tunnel"
mkdir -p "$DEPLOY_DIR/release" "$DEPLOY_DIR/data"
cp -R dist "$DEPLOY_DIR/release/"
cp docker-compose.yml "$DEPLOY_DIR/"
cp .env.example "$DEPLOY_DIR/.env"
chmod 600 "$DEPLOY_DIR/.env"
# 配置下表字段后启动。
cd "$DEPLOY_DIR"
docker compose config --quiet
docker compose up -d
```

`.env` 是部署默认值的唯一来源。账号口令与 API token 请使用独立随机值。

| 字段 | 用途 |
| --- | --- |
| `TUNNEL_PUBLIC_URL` | 控制台 HTTPS 地址，也是浏览器 Origin 白名单 |
| `TUNNEL_BIND` / `TUNNEL_PORT` | 服务监听地址和端口，建议只监听 loopback，由现役 Caddy 代理 |
| `TUNNEL_DOMAIN` | 登记域名的后缀 |
| `TUNNEL_RAW_HOST` | 公网别名 CNAME 目标，例如 `raw.example.com`；该入口的 A 记录由 DDNS 或管理员维护 |
| `TUNNEL_LAN_IP` / `TUNNEL_ALLOWED_CIDRS` | 内网入口地址与允许访问的 LAN / EasyTier CIDR，逗号分隔 |
| `TUNNEL_ADMIN_USER` / `TUNNEL_ADMIN_PASSWORD` | 控制台账号密码 |
| `TUNNEL_API_TOKEN` | sidecar 或自动化调用使用的服务端凭据 |
| `TUNNEL_CADDY_LISTENER` | Caddy HTTPS 监听地址，用于存在多个实例时精确选择服务 |
| `TUNNEL_CADDY_ADMIN` | 现役 Caddy 本机管理端点，必须已有控制台域名路由 |
| `TUNNEL_CF_ZONE` / `TUNNEL_CF_TOKEN` | Cloudflare zone 与 DNS 编辑 token；不配置时可管理内网服务，公网发布会阻断 |

在现役 Caddy 为 `TUNNEL_PUBLIC_URL` 对应域名配置反向代理，目标为 `TUNNEL_BIND:TUNNEL_PORT`。部署者负责该域名 DNS、证书与公网端口可达性。不要把 Caddy 管理端口暴露到公网。

## 服务管理

- 「保存」只更新草稿；「应用配置」才发布。全部公网 DNS 计划通过后才更新 Caddy。
- `internal` 不创建公网 DNS，Caddy 使用直接连接的来源 IP 白名单，其他来源返回 404。证书使用 Caddy 内部 CA，客户端须信任该 CA。
- `public` 创建 DNS-only CNAME 指向 `TUNNEL_RAW_HOST`。Caddy 负责后续 ACME，**DNS 写入成功不等于证书已经签发或公网已可达**。
- 内网 DNS 片段写入 `data/dns/tunnel.conf`，需要主机解析器加载。应用不会擅自修改路由器 DHCP 或 DNS。
- Caddy 只修改 `tunnel-services` 与 `tunnel-internal-certificates` 两个命名资源，保留其他服务；Caddy 热加载后最多 30 秒恢复上次成功发布的数据，草稿不会自动发布。
- 删除登记后应用会移除代理路由。已有公网 DNS 不会自动删除，避免误删其他系统管理的记录；公网转内网时也应由域名管理员检查旧入口。
- 目标主机可填写已有 EasyTier 节点的地址或可解析名称。本版复用现有网络，不安装 EasyTier，不提供设备配对协议或公网中继。

外部 DNS API 无法与 Caddy 构成跨系统事务；发布过程中任何错误都会返回失败，已完成的步骤可能已生效，修正后再次应用即可协调。

## AIO sidecar

见 [AIO.md](AIO.md)。适配器使用 Unix socket、宿主身份头、租户和用户白名单；核心状态和凭据不复制进插件。

## CLI / provider

```sh
node dist/cli.mjs --help
```

兼容原来的 `AIO_PORTAL_HOME` 配置与 CLI。CLI 可选择 Cloudflare、腾讯 DNSPod、华为云 IAM token、本地 dnsmasq。**当前 Web 控制台的公网适配为 Cloudflare；华为 AK/SK 与腾讯 SecretId/SecretKey 未在本版提供。**

## 验证与发布

`npm test` 执行 CLI、HTTP 登录与持久化、内网策略、被阻断的公网发布和 AIO sidecar 身份测试。GitHub Actions 在 main 推送后执行同一命令并生成 `tunnel.tar.gz`；部署前用实际 Caddy 和入口验证。

仅将服务密码保存在部署 `.env`，不提交到 Git。项目提供 MIT 授权。
