# AIO 服务入口

AIO 中安装原生 v2 process 插件，菜单显示「服务入口」。前端复用独立控制台，后端通过宿主 Unix broker 调用同一个 Tunnel 服务；沙箱保持无网络，令牌不会进入网页或插件包。

## 打包与安装

```sh
npm ci
npm test
node --env-file="$TUNNEL_ENV_FILE" scripts/package-aio.mjs
```

打包在 Linux x64 上使用 gcc 生成 ELF 入口，脚本内容嵌入该产物并由批准镜像中的 Node 执行；不新增 Dockerfile。测试会实际启动打包后的 ELF，检查进程描述接口。

`.env` 提供 `TUNNEL_NODE_IMAGE`（锁定 digest）和 `TUNNEL_AIO_ENDPOINT`（完整 `/api/aio` 地址）。`dist/tunnel.aio-plugin` 是待安装整包，脚本打印真实 commit/digest。将该端点添加到宿主 `AIO_PROCESS_HTTP_ENDPOINTS`；复用宿主已批准的 Node 镜像。通过 AIO 发布/安装 API 或已有 `bootstrap_components` 引导加载，不能以「文件复制完成」代替插件激活检查。

插件数据库的 `tunnel_connection` 只有一条部署连接：`endpoint`、使用宿主 `encryption_key` 的 AES-256-GCM 加密 `token`、允许的 `users` 数组。密文格式为 base64(iv[12] + tag[16] + ciphertext)。部署者写入该表；不向插件授予其他应用数据库权限。宿主先校验有效会话、租户和插件活动版本，sidecar 再校验 ingress token 与用户白名单，Tunnel 再校验服务令牌、租户和用户。

## 配对与地址

在服务器上使用设备助手现有配对流程：

```sh
aio device connect --server "$AIO_URL" --name "$DEVICE_NAME"
```

设备名称随配对申请保存。入口只读查询 AIO 的活动配对；数据库账号只需 `worker_devices` 的 id、label、last_seen、state、tenant_id、user_id 列 SELECT 权限。配置 `TUNNEL_AIO_DATABASE_URL` 和管理范围 `TUNNEL_AIO_TENANT`、`TUNNEL_AIO_USERS`，不会创建第二套设备身份。

在「配对设备」绑定 EasyTier 地址。添加服务时选择设备，目标主机留空表示该设备本机；填写子网地址表示入口已通过 EasyTier 子网路由可达的目标。配对和网络可达分别验证；发布前探测实际端口，离线或端口不可达会显示失败。撤销配对后，恢复循环会在 30 秒内移除对应 Caddy 路由。EasyTier 网络和子网路由需事先配置，不会擅自劫持客户端直连路由。

## 内网解析加载

发布生成 `data/dns/tunnel.hosts`。现役 dnsmasq 可通过 `addn-hosts=<该文件>` 加载；用 systemd path unit 监听文件，触发 `systemctl kill -s HUP dnsmasq`。首次增加 addn-hosts 配置需校验并重载服务，后续发布只发 HUP。无需修改路由器 DHCP。

验收应分别检查 AIO 菜单、配对归属、目标端口、云 DNS 读回、DNS 解析、HTTPS 业务响应和内网来源排除。端口可达与配置已应用不代表证书已经签发。
