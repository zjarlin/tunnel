# 管理界面

原生 HTML、CSS 和 JavaScript。独立部署使用 HttpOnly 登录会话，AIO 沙箱内复用宿主注入的 `aioPlugin.json`，不向浏览器传递 sidecar API token。

服务表同时展示 HTTP 服务和现有内网 TCP 入口。HTTP 支持打开 HTTPS 入口，TCP 显示域名与端口；都可复制连接地址。只读 TCP 行不提供编辑或删除，后端同时拒绝绕过界面的写请求。刷新按钮重新读取真实目录，并展示条目总数。
