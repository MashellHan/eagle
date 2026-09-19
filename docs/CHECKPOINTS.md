# 用户视角检查点

## 2026-09-19 13:58 +08:00（15 分钟）

- 用户可访问 https://eagle.dev.hexly.ai（Caddy → 6001 Vite → 36001 Worker），HTTPS 200，私密登录已可用。
- 真实采集覆盖本机 15 Space、30 Pane；完整布局、Codex 最终回复/Goal、Git、前台进程已形成 v1 report，没有采集缺口。
- 16 项 Schema/判断/Worker D1/采集测试通过；4 项桌面/手机浏览器行为测试通过。
- 本轮发现的真实阻断点：dotenv 的嵌套 JSON 转义、Wrangler dev 不热更新 secret。已用单引号写入安全配置，并重启本项目 dev Worker。继续用真实上传与浏览器验证修复效果。
- 不把测试通过或 Herdr 的 done 当发布完成。下一检查点核对：认证上传 → D1 中的真实清单 → 页面全量 Space → 无手动刷新更新。
