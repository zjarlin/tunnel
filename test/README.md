# FRP 通道验收

`node scripts/test-frp.mjs` 下载并校验官方 FRP 二进制后运行完整测试，CI 使用同一命令。frps/frpc 只监听随机回环端口，配置与日志位于临时目录，结束后清理；不创建常驻 Docker 服务。

验证真实 HTTP 内容经 FRP 转发、内网 Caddy 策略、旧客户端保留连接方式、断线阻止发布、非回环映射阻止发布并撤下恢复路由，以及删除登记不停止其他系统管理的 FRP。普通 `npm test` 在未设置 `FRP_TEST_BIN_DIR` 时明确跳过这项外部二进制测试。
