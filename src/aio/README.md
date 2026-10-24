# AIO sidecar

适配 AIO v2 `/health`、`/aio/describe`、Unix socket 和 `x-aio-*` 身份头。指定租户及管理员用户白名单后，代理服务登记 API 到独立 Tunnel 服务；不会重建核心状态。

运行 `node dist/sidecar.mjs`。必填：`AIO_PLUGIN_CONFIG`、`AIO_PLUGIN_SOCKET`（宿主提供），以及 `TUNNEL_URL`、`TUNNEL_API_TOKEN`、`TUNNEL_AIO_TENANT`、`TUNNEL_AIO_USERS`（逗号分隔用户 ID）。前端资源使用 `dist/web`。不要将 API token 放进前端。

本适配器须由有网络访问权限的 sidecar 环境运行。AIO 受限 process 沙箱的网络策略和打包安装由宿主部署负责，不声明已经安装到现役 AIO。
