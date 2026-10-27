# Tunnel

服务入口控制台。用户视角只有三步：**配对设备 → 填内网地址 → 选 DNS 服务商**，再由一台**发布节点**（VPS / 中继出口）把服务公开到公网。实现上复用 Caddy、ACME 与现有中继网络，但这些不出现在界面里：界面只出现「配对设备」「中继地址」「发布出口」「访问范围」。AIO 可通过 sidecar 接入同一个 API；独立控制台可单独运行；启用配对设备列表时只读接入 AIO 的共享 PostgreSQL。

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
| `TUNNEL_LAN_IP` / `TUNNEL_ALLOWED_CIDRS` | 内网入口地址与允许访问的 LAN / 中继网段（CIDR，逗号分隔） |
| `TUNNEL_ADMIN_USER` / `TUNNEL_ADMIN_PASSWORD` | 控制台账号密码 |
| `TUNNEL_API_TOKEN` | sidecar 或自动化调用使用的服务端凭据 |
| `TUNNEL_CADDY_LISTENER` | Caddy HTTPS 监听地址，用于存在多个实例时精确选择服务 |
| `TUNNEL_CADDY_ADMIN` | 现役 Caddy 本机管理端点，必须已有控制台域名路由 |
| `TUNNEL_CF_ZONE` / `TUNNEL_CF_TOKEN` | Cloudflare zone 与 DNS 编辑 token；不配置时可管理内网服务，公网发布会阻断 |

在现役 Caddy 为 `TUNNEL_PUBLIC_URL` 对应域名配置反向代理，目标为 `TUNNEL_BIND:TUNNEL_PORT`。部署者负责该域名 DNS、证书与公网端口可达性。不要把 Caddy 管理端口暴露到公网。

## 唯一注册表（与服务门户共用）

服务登记只有一份，存在统一 postgres 的 `aio` 库 `portal.service` 一张表里
（`alias` 主键 + `data jsonb`，schema 见 `src/portal/schema.sql`）。
控制台与 `aio-portal`（182 内网入口）读写同一条记录，每条登记用 `edges` 声明由哪些入口渲染：

- `localmesh`：182 的 localmesh Caddy + dnsmasq，由 `aio-portal sync` 落地产物；
- `home-edge`：本控制台发布的外部入口（Caddy admin + 公网 DNS + 证书）。

本服务只发布 `edges` 含 `home-edge` 且未停用的条目；`disabled: true` 两个入口都不渲染。
控制台保存表单时只改自己那几个字段，`edges`、`stream`、`tls`、`suffix` 等由别的入口写入的字段原样保留。

连接串取自 `TUNNEL_REGISTRY_DATABASE_URL`（容器里指向统一 postgres 的 `portal_rw`）。
**只有**在没有连接串时（本地开发 / CI）才回落到 `$TUNNEL_DATA/aliases.json` 文件驱动；
配了连接串却连不上会直接报错，不会静默改读文件。

历史 JSON 注册表用 `aio-plugin-portal import --from <aliases.json>` 一次性灌进数据库（幂等：
已存在的别名以数据库为准）。从"两套表"迁移到一套时用
`node scripts/migrate-shared-registry.mjs [--apply] [--mirror <路径>]`。
注册表已经是唯一一份，旧的单向同步（`tunnel-lan-edge.timer` 把控制台登记抄进内网表）
已在 2026-10-27 `disable --now`，**不要再启用**。

## 一份前端，两种部署

`web-src/panel.ts` 是「服务入口」面板（表格 + 登记/编辑 + 配对设备 + DNS 账号 + 发布状态）的
**唯一实现**，`tunnel.addzero.site` 独立控制台与 `aio.addzero.site/?page=space-tunnels` 内嵌页
跑的是同一份代码，只有两处不同：

| | 独立控制台 | AIO 内嵌页 |
| --- | --- | --- |
| transport | `fetch('/api/*')` + cookie 登录 | 宿主代理（`INFRA` 方法 → `/api/runtime/components/<token>/request`） |
| 能力开关 | 密码本、Excel 导出、入口归属列、DNS 方式、备注列 | 设备隧道入口、发布状态列、合并旧菜单、设备筛选 |

- 独立站的 `dist/web/app.js` 由 `web-src/shell.ts`（登录 / 密码本 / 导出 + 面板）构建，
  `web/` 只留 `index.html` 与 `style.css`，不再手写业务脚本。
- AIO 页的那份是 `aio-plugin-device` 仓库里的逐字节副本，由
  `node scripts/sync-tunnel-panel.mjs` 同步并记录来源 commit + sha256（`--check` 校验漂移）。
  改面板只改这里，然后同步过去，不要再在设备插件里另写一套表单项。

## 服务管理

- 「保存并应用」保存表格后立即发布；逐步显示设备端口、DNS 预检、Caddy 和云记录读回状态。全部 DNS 计划通过后才更新 Caddy。
- 「连接方式」不再让用户选择：表单里只保留配对设备与内网地址两项，界面按登记内容自动显示「设备中继」「—」或「FRP 映射（遗留）」。历史 FRP 条目继续可用（Frps TCP 映射 / frpc STCP visitor：填写映射地址与端口，发布前实测连通性），但本服务不安装、修改或删除已有 frps/frpc 配置。
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
- 选择 AIO 已配对设备并绑定中继地址，支持设备本机服务和通过已有子网路由可达的服务；复用现役中继网络，不安装第二套网络或配对协议。
- 目标地址解析三种情况：没绑设备时填写的主机就是最终目标；绑了设备又填了主机时按填写的主机走；绑了设备但目标留空时用该设备的中继地址。只有「服务就在发布节点本机」才允许写 `127.0.0.1`，其他设备的回环直接报错，不会静默探测错误地址。
- 上游探测只报问题不拦发布：某台后端离线时其余路由照常下发，发布记录与该条目会标注「上游暂不可达」，访问该域名返回 502。

外部 DNS API 无法与 Caddy 构成跨系统事务；发布过程中任何错误都会返回失败，已完成的步骤可能已生效，修正后再次应用即可协调。

## 发布节点（VPS / 中继出口）

配对设备里可以指定**一台**发布节点，界面上的「角色」列显示为「发布出口」，页头同时显示当前发布出口（如 `addzero.site · 49 项服务 · 发布出口 okm182`）。

- 发布节点负责公网入口、证书与 DNS，全机唯一：把另一台设为发布节点会自动摘掉上一台的角色，但保留它的中继地址。
- 发布记录第一步会写明「发布出口 <设备名>」；未指定时写明「未指定发布节点，按本机出口发布」，不静默猜测。
- 角色与地址分开存：`data/devices.json` 为 `{"<设备ID>": {"address": "...", "role": "publish"}}`，历史字符串格式 `{"<设备ID>": "<地址>"}` 读入时自动归一，不会丢地址。
- 目标地址解析三种情况见上一节；发布节点本机服务写 `127.0.0.1` 是合法的，其他设备的回环会直接报错。
- 一键测速在登记处（`aio-plugin-portal`）：`GET`/界面「一键测速」，延迟按 RGB 从绿到红上色，异常域名退出码非 0。

## 与 AIO 的边界（能否砍掉 tunnel.addzero.site）

本项目**已经是**一个 AIO 插件包（`scripts/package-aio.mjs` 产出 `dist/tunnel.aio-plugin` 与 `aio-manifest.toml`，含 `plugin.runtime` / `plugin.frontend` / `plugin.database`），
sidecar 走宿主 broker `/egress/http` 转发 `/api/{services,apply,devices,accounts,publications}`。但当前 `tunnel.addzero.site` 仍是独立的宿主侧发布面，原因是**发布动作落在宿主上，而不是插件沙箱里**：

| 发布节点要做的事 | 现在的执行位置 | 插件沙箱现状 |
| --- | --- | --- |
| Caddy 路由 / 访问范围 | 宿主 Caddy admin `127.0.0.1:2019` | `network=none`，访问不到 Caddy admin |
| 公网 DNS | 宿主进程直连云 DNS API | 需走宿主 broker 白名单端点 |
| ACME 证书 | 宿主进程 + 宿主证书目录 | 需宿主代理写盘与开放 80/443 |
| 内网 DNS 文件 | `data/dns/tunnel.hosts` | 需宿主 reload 解析器 |

因此砍掉 `tunnel.addzero.site` 的前置条件是宿主侧提供 edge agent（暴露 Caddy reload、ACME、DNS 写入、解析器 reload 四类受控操作），
并在**双跑对账**（同一批域名两个入口都发布、逐个比对 Caddy 路由 / 证书 / DNS 读回）通过后再停旧容器、删 CNAME。
在 edge agent 落地前，`aio-plugin-device` 的隧道只做**登录态中继访问**（`/api/runtime/device-tunnels*`，一次性 ticket），
没有自定义域名、没有 ACME、没有公网 DNS、没有 TCP，`--public` 显式返回未授权——它现在不能承担「配对后一键暴露到公网」这件事。

## 密码本（凭据登记）

控制台内置密码本，用于登记服务账号、数据库口令、云控制台与 API 令牌，和「服务入口」共用同一套登录与来源校验。

- 落盘 `data/vault.enc`，AES-256-GCM 加密，密钥复用部署 `.env` 的 `TUNNEL_SECRET_KEY`（与 DNS 账号密文分开存放，AAD 固定 `vault.v1`）；文件权限 0600。
- 列表接口只返回名称、分类、地址、账号和「是否已保存密码」，**永不返回口令**；只有显式「查看并复制」才由 `POST /api/vault/reveal` 回传单条口令，并在服务端日志记录 `vault reveal <id> <名称>`。
- 编辑其他字段时密码留空表示沿用旧口令，避免为了改备注重输密钥。
- 接口：`GET /api/vault`、`PUT /api/vault`、`POST /api/vault/reveal`、`DELETE /api/vault/<id>`，与其它接口一样接受控制台会话或 `TUNNEL_API_TOKEN`（AIO 侧车走 `/api/aio` 信封）。
- 备份：密码本与 DNS 账号一起备份 `data/vault.enc` 与 `TUNNEL_SECRET_KEY`；丢失密钥即无法恢复，禁止只备份密文。

### 导出 Excel

控制台右上角「导出 Excel」与密码本窗口内的两个按钮，下载同一个 `GET /api/export.xlsx`：

- 工作簿含三张表：「服务登记」（域名 / 访问范围 / 连接方式 / 目标 / 协议 / 设备 / DNS 方式 / 备注）、「密码本」、「导出说明」（导出时间、控制台地址、条数、是否含明文）。
- **默认不导出明文口令**，密码列只写「已登记，未导出明文」；点「导出（含明文）」并二次确认后才带 `?secrets=1`，口令以明文落在本机文件里，请在服务端日志 `vault export xlsx <条数>` 与二次确认上把关。
- 只依赖 Node 内置 `zlib` 手写 OOXML（`src/server/excel.ts`），不引入第三方表格库；表头加粗、冻结首行、列宽按内容自适应，单元格超 32000 字符会截断。
- AIO 侧车只能回 JSON，导出固定在独立控制台；侧车调用该接口返回 400。

## 天津服务登记约定

- 设备隧道在 AIO「设备助手 → 内网服务」登记，命名 `tj-<服务>`（tianjin-server）与 `tjai-<服务>`（tianjin AI 机），域名后缀统一 `lyokm.cn`。
- 控制台为每个域名登记一条服务并单独签发证书，目标分两种：
  - 远端监听在 `0.0.0.0` / 中继地址：直接写 `<中继 IP>:<端口>`，请求由 Caddy 走中继直连，浏览器不需要 AIO 登录。
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

## 证书签发（命令行脚本）

控制台发布时会自动申请证书；内置 ACME 报 `ACME 连接失败`（实际外网可达，属其内部问题）时，用脚本单独签发，产物会被控制台直接加载、跳过重复签发：

```sh
# 华为云 DNS-01（lyokm.cn 等）
node scripts/issue-certificate.mjs <域名> [...]

# Cloudflare DNS-01（addzero.site 等），可一次多个，--out 导出给 file-based Caddy
TUNNEL_CF_TOKEN=... TUNNEL_CF_ZONE=... node scripts/issue-certificate-cf.mjs <域名> [...] [--out <目录>] [--force]
```

两者都写 `<TUNNEL_DATA>/certificates/<域名>.json`；`--out` 额外导出 `<tls-<域名点转横线>>/{fullchain.pem,privkey.pem}`，给 `tls <pem> <key>` 的站点用（例：`company-ai.addzero.site`、`macmini-ai.addzero.site` 的 localmesh 站点）。缺省环境变量从 `TUNNEL_ENV_FILE`（默认 `/root/DockerCompose/tunnel/.env`）读取，令牌不入库。

## 验证与发布

`npm test` 执行 CLI、HTTP 登录与持久化、内网策略、被阻断的公网发布和 AIO sidecar 身份测试。GitHub Actions 在 main 推送后执行同一命令并生成 `tunnel.tar.gz`；部署前用实际 Caddy 和入口验证。

仅将服务密码保存在部署 `.env`，不提交到 Git。项目提供 MIT 授权。

多个 Caddy 共享 admin 地址时，设置 `TUNNEL_CADDY_LISTENER=*` 和实际 `TUNNEL_CADDY_INSTANCES`，每个实例读回 ETag 后独立更新。接管已有站点只允许 `TUNNEL_ADOPT_DOMAINS` 显式列出的单域路由，并要求上游完全相同。
