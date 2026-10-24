# AIO sidecar 接入

Tunnel 独立运行。AIO 只加载 `dist/web` 和 `dist/sidecar.mjs`，通过服务 API 使用同一份登记数据。

```sh
node dist/sidecar.mjs
```

宿主提供 `AIO_PLUGIN_CONFIG`、`AIO_PLUGIN_SOCKET`。管理员配置 `TUNNEL_URL`、`TUNNEL_API_TOKEN`、`TUNNEL_AIO_TENANT` 和 `TUNNEL_AIO_USERS`。最后两个字段限定允许访问基础设施管理能力的租户与用户，不默认授权全部 AIO 用户。

适配器实现 AIO v2 的 `/health`、`/aio/describe` 和 Unix socket 业务请求。`dist/web` 复用宿主注入的 `aioPlugin.json`。API token 只存在服务端。

独立部署不依赖 AIO 在线，也不连接 AIO 数据库。宿主 process 沙箱必须允许到 Tunnel 的网络连接；本仓库提供可运行适配器和接口测试，不自动修改正在运行的 AIO 插件组合。
