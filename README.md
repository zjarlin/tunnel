# Tunnel

独立部署的服务入口控制台。通过表格登记域名别名、目标主机、端口和访问范围，复用 Caddy 与现有 EasyTier 网络。AIO 可通过 sidecar 接入同一个 API；独立控制台可单独运行；启用配对设备列表时只读接入 AIO 的共享 PostgreSQL。

本项目从 [aio-plugin-portal](https://github.com/org-aio/aio-plugin-portal) 保留 Git 历史演进而来。DNS provider 与 CLI 代码在这里继续维护；AIO 适配只承担身份校验和 API 转发。

## Docker Compose

使用官方 Node 镜像，无 Dockerfile，不启动额外数据库或 Caddy。

从 GitHub Release 下载 `tunnel.tar.gz` 后，直接解压到 `$HOME/DockerCompose/tunnel`，复制 `.env.example` 为 `.env` 并填写配置即可 `docker compose up -d`。从源码部署：

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

- 「保存并应用」保存表格后立即发布；逐步显示设备端口、DNS 预检、Caddy 和云记录读回状态。全部 DNS 计划通过后才更新 Caddy。
- 「连接方式」可选 EasyTier / 直连或 FRP 映射。FRP 使用已经运行的 frps TCP 映射或 frpc STCP visitor：填写映射地址与端口，发布前实测连通性，再配置同一套 DNS、Caddy 和证书；可关联配对设备，但不要求 EasyTier 地址。此入口不安装、修改或删除已有 frps/frpc 配置。
- 控制台通过额外 HTTPS 端口访问时，在部署 `.env` 的 `TUNNEL_EXTRA_ORIGINS` 配置完整来源（逗号分隔）；只接受与 `TUNNEL_PUBLIC_URL` 同协议、同域名的其他端口，登录和表单提交仍拒绝其他来源。
- HTTPS FRP 映射需填写真实上游证书的 TLS 主机名，Caddy 使用该名称验证证书；不会因映射地址为回环而关闭 TLS 校验。
- 仅内网 FRP 必须使用本机 `127.0.0.1` 映射，并将 frps 的 `proxyBindAddr` 或 visitor 的 `bindAddr` 设为 `127.0.0.1`；Linux 宿主网络中会检查实际 TCP 监听，发现通配或非回环监听会阻止发布。每 30 秒恢复路由时也会检查，异常路由会从 Caddy 撤下。公网 FRP 可填写可达的中转主机名与端口。
- `internal` 不创建公网地址记录，Caddy 使用直接连接的来源 IP 白名单，其他来源返回 404。选有云账号且配置 ACME 时自动申请 DNS 验证证书，否则使用 Caddy 内部 CA。
- 正式证书加载后按 SNI 和证书标签选择，避免 Caddy 缓存中的内部 CA 证书继续被使用；保留其他站点的 TLS 连接策略。
- `public` 创建 DNS-only CNAME 指向 `TUNNEL_RAW_HOST`。云账号配合 ACME 配置自动签发、安装并续期 HTTPS 证书；未配置时使用 Caddy 默认 ACME。公网端口可达性仍需单独验收。
- 已有公网入口可选择「保留现有公网 DNS」：只读检查现有 A/AAAA/CNAME，仍生成内网 DNS、Caddy 与证书，不迁移或撤销原公网入口。此模式必须选择 DNS 账号；删除登记不会关闭原入口，改为仅内网前须先在原系统关闭入口，再删除登记并重新添加。
- 内网 DNS 记录写入 `data/dns/tunnel.hosts`，需要主机解析器加载，见 AIO.md。应用不会擅自修改路由器 DHCP 或 DNS。
- Caddy 只修改 `tunnel-services-*` 与 `tunnel-internal-certificates` 命名资源，保留其他服务；Caddy 热加载后最多 30 秒恢复上次成功发布的数据，草稿不会自动发布。
- 配置 DNS 账号的服务在删除或公网转内网时移除本系统管理的 DNS 记录；遇到其他系统的记录会阻止发布。旧版默认 Cloudflare 配置需人工确认旧记录归属。
- 选择 AIO 已配对设备并绑定 EasyTier 地址，支持设备本机服务和通过已有子网路由可达的服务；复用现役 EasyTier，不安装第二套网络或配对协议。

外部 DNS API 无法与 Caddy 构成跨系统事务；发布过程中任何错误都会返回失败，已完成的步骤可能已生效，修正后再次应用即可协调。

## 密码本（凭据登记）

控制台内置密码本，用于登记服务账号、数据库口令、云控制台与 API 令牌，和「服务入口」共用同一套登录与来源校验。

- 落盘 `data/vault.enc`，AES-256-GCM 加密，密钥复用部署 `.env` 的 `TUNNEL_SECRET_KEY`（与 DNS 账号密文分开存放，AAD 固定 `vault.v1`）；文件权限 0600。
- 列表接口只返回名称、分类、地址、账号和「是否已保存密码」，**永不返回口令**；只有显式「查看并复制」才由 `POST /api/vault/reveal` 回传单条口令，并在服务端日志记录 `vault reveal <id> <名称>`。
- 编辑其他字段时密码留空表示沿用旧口令，避免为了改备注重输密钥。
- 接口：`GET /api/vault`、`PUT /api/vault`、`POST /api/vault/reveal`、`DELETE /api/vault/<id>`，与其它接口一样接受控制台会话或 `TUNNEL_API_TOKEN`（AIO 侧车走 `/api/aio` 信封）。
- 备份：密码本与 DNS 账号一起备份 `data/vault.enc` 与 `TUNNEL_SECRET_KEY`；丢失密钥即无法恢复，禁止只备份密文。

## 天津服务登记约定

- 设备隧道在 AIO「设备助手 → 内网服务」登记，命名 `tj-<服务>`（tianjin-server）与 `tjai-<服务>`（tianjin AI 机），域名后缀统一 `lyokm.cn`。
- 控制台为每个域名登记一条服务并单独签发证书，目标分两种：
  - 远端监听在 `0.0.0.0` / EasyTier 地址：直接写 `<EasyTier IP>:<端口>`，请求由 Caddy 走 EasyTier 直连，浏览器不需要 AIO 登录。
  - 远端只监听 `127.0.0.1`（例如 `edge-laya` 所在的容器）：写 `127.0.0.1:8091`（AIO 隧道网关，按 Host 分流），访问者必须从 AIO 设备助手打开，否则返回「请从 AIO 设备助手打开此服务」。
- `public` = 公网可访问（DNS 为 CNAME 到 `raw.<域名>`）；`internal` = 仍发布域名，但 Caddy 只放行 `192.168.31.0/24`、`10.144.144.0/24`，其他来源 404。
- 局域网浏览器解析 `*.lyokm.cn` 走 182 的 localmesh（不是本控制台的 home-edge），因此同一批域名还要在 `aio-plugin-portal` 登记一次（`/root/DockerCompose/aio-portal/aliases.json`，内网 CA + 同一 allowlist），两处 `host:port` 必须一致。
- 只监听远端回环、且未发布宿主端口的容器（例如 `edge-laya`）需要先在目标机补端口映射才能直连；控制台不代为改动远端编排。

## AIO sidecar

见 [AIO.md](AIO.md)。适配器使用 Unix socket、宿主身份头、租户和用户白名单；核心状态和凭据不复制进插件。

## CLI / provider

```sh
node dist/cli.mjs --help
```

Web 控制台支持 Cloudflare API Token、华为云 AK/SK、腾讯云 SecretId/SecretKey；两家国内云使用官方 SDK 签名。凭据以 AES-256-GCM 加密保存，页面只显示配置状态。公网别名创建 DNS-only CNAME 指向唯一 `raw.<域名>` A 记录，内网服务不创建公网记录。CLI 保留原有 provider 配置。

## 验证与发布

`npm test` 执行 CLI、HTTP 登录与持久化、内网策略、被阻断的公网发布和 AIO sidecar 身份测试。GitHub Actions 在 main 推送后执行同一命令并生成 `tunnel.tar.gz`；部署前用实际 Caddy 和入口验证。

仅将服务密码保存在部署 `.env`，不提交到 Git。项目提供 MIT 授权。

多个 Caddy 共享 admin 地址时，设置 `TUNNEL_CADDY_LISTENER=*` 和实际 `TUNNEL_CADDY_INSTANCES`，每个实例读回 ETag 后独立更新。接管已有站点只允许 `TUNNEL_ADOPT_DOMAINS` 显式列出的单域路由，并要求上游完全相同。
