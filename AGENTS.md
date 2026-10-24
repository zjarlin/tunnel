# Tunnel 的可选连接方式

- 用户已明确要求在界面选择 FRP。本仓库保留 EasyTier 与 FRP 两种入口连接方式；这项要求优先于工作区默认的“隧道统一使用 EasyTier”约定。
- FRP 复用现有 TCP 映射或 STCP visitor，不恢复退役链路，不接管其他服务的 frps/frpc 配置。
- 仅内网访问必须同时验证 Caddy 来源限制与 FRP 映射端口的回环监听，不能只隐藏 DNS 记录。
- `sub2api` 和共享数据库不可中断；发布 Tunnel 时只更新本仓库的独立服务。
