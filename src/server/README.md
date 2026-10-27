# 独立服务

登录会话、服务登记和 Caddy 命名路由发布。环境变量是部署配置的唯一来源，数据不依赖 AIO 或数据库。
DNS 适配复用门户 provider，内网登记不会创建公网 DNS。发布先检查全部计划；失败如实返回，外部 DNS 写入不能作为事务回滚。

`TUNNEL_TCP_CATALOG` 可接入现有内网 TCP 代理成功校验后生成的 JSON 目录。`/api/services` 合并返回 HTTP 登记和 TCP 入口，TCP 条目标明 `scheme=tcp`、`readOnly=true`、`visibility=internal`。保存、删除和 HTTP 发布不能修改这些入口，也不会为其创建 Caddy HTTP 路由、证书或公网 DNS。文件不存在、无效或别名冲突时返回明确错误，不静默显示空列表。

服务连接由登记内容推断（设备中继 / 入口直连 / 遗留 FRP 映射），界面不再让用户选择传输方式。FRP 不依赖设备的 mesh 地址，发布始终检查映射端口；仅内网 FRP 额外检查 Linux 宿主网络中的实际回环监听，避免通过中转端口绕过来源白名单。配对撤销仍会移除对应入口。
