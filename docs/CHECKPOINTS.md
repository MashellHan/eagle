# 用户视角检查点

## 2026-09-19 13:58 +08:00（15 分钟）

- 用户可访问 https://eagle.dev.hexly.ai（Caddy → 6001 Vite → 36001 Worker），HTTPS 200，私密登录已可用。
- 真实采集覆盖本机 15 Space、30 Pane；完整布局、Codex 最终回复/Goal、Git、前台进程已形成 v1 report，没有采集缺口。
- 16 项 Schema/判断/Worker D1/采集测试通过；4 项桌面/手机浏览器行为测试通过。
- 本轮发现的真实阻断点：dotenv 的嵌套 JSON 转义、Wrangler dev 不热更新 secret。已用单引号写入安全配置，并重启本项目 dev Worker。继续用真实上传与浏览器验证修复效果。
- 不把测试通过或 Herdr 的 done 当发布完成。下一检查点核对：认证上传 → D1 中的真实清单 → 页面全量 Space → 无手动刷新更新。

## 2026-09-19 14:13 +08:00（30 分钟）

- 生产 https://eagle.hexly.ai 已部署；`/api/live` 返回 Git revision 0d83f3699c3797c3eeadb5e524c508b7cdefd6c5。
- 14:09 生产真实验证通过：本机 15 Space、30 Pane，采集 → Bearer 认证 → D1 → 桌面/手机页面，全量清单一致；重复上报、自动刷新、详情、历史、匿名 401 均验证成功。
- 首屏已加入最近变化和最近采集摘要；完成数不包含失去心跳或采集过期的快照。原始终端摘录只在证据详情使用。
- Grok 只读 Review 指出的旧任务重绑定、告警被心跳清除、停止 Session 的历史拓扑和坏 spool 阻塞问题，已逐项添加失败用例并实现修复。Origin 403 推测未在真实 HTTPS 链路中复现（多次实际登录成功）。Pi 因连接错误未提供有效 Review。
- 正在跑修复后的全套检查，然后更新生产并配置本机定期上报。最终验收仍以新版本的实际线上数据为准。

## 2026-09-19 14:22 +08:00（发布收尾）

- 14:14 本地、14:15 生产真实端到端验证通过，均为 15 Space、30 Pane。匿名拒绝、私密登录、幂等上传、D1 清单、全量页面、自动刷新、历史和手机布局全部通过。
- 生产本机 LaunchAgent 已持续按 30 秒间隔成功上报，无采集告警或错误日志；页面每 5 秒更新。其它物理机器尚未接入，复用 Skill 和接入文档已提供。
- `21e55da` 的 GitHub CI 全绿；Grok 确认实际 HTTP 400 → UploadRejectedError → spool 隔离路径闭环，无剩余该项 P0/P1。
- 最终恢复检查新增了两个先失败的用例：成功 HTTP 响应缺少有效入库回执时保留报告；1000 条积压队列先重传再采集。修复后 31 项单元/集成测试通过，6 项桌面/手机浏览器测试通过。正在核对完整发布检查和最终部署版本。

## 2026-09-19 · Identity and Hexly onboarding checkpoint

Prepared in an isolated checkout while the original checkout's Access migration
continues independently. The golden eagle is installed in README, transparent
sidebar (expanded/collapsed), loading/login marks and seven-resolution browser
ICO. GitHub → Hexly → Theme controls share Basalt tooltips. Existing business
credentials and reporting data are unchanged by this batch.

A real Miniflare/D1 check first demonstrated the missing public health version;
the endpoint now reads the root package version and retains dependency failure,
no-store, revision and anonymous-read semantics. 31 API/agent/unit checks and
8 desktop/mobile browser cases passed. Browser fixtures are test-only; these
results are not a claim of real-machine or production verification. Next hop:
merge current published authentication changes, then verify actual local/public
serving and the first catalogue-derived production Cron observation.


## 2026-09-19 15:16 +08:00（Access 与视觉改版，15 分钟）

- Access 签名、issuer、audience、过期和旧凭据拒绝测试已通过；本地免登录严格限定开发开关与本地主机名。Grok 只读认证 Review 未发现 P0/P1。
- 真实 Herdr 采集仍为 15 Space / 30 Pane；15:16 本地无登录端到端验证通过，覆盖认证上传、D1、幂等重传、全量 Space、自动更新、详情、历史及桌面/手机渲染。
- 本地检查发现 Wrangler 默认把 hostname 设成生产域名，已设置 dev.host；Vite 测试/开发服务共享缓存导致真实页面 504，已隔离缓存。上述修复均经过真实浏览器复验。
- 视觉重构已实现紧凑机器分组、Space 拓扑、状态筛选、变更节奏、Agent 分布、证据覆盖和骨架加载；8 项桌面/手机交互测试通过。正在检查真实数据下的最终排版。
- 公网现有 Access 同时阻断原机器上传；独立 eagle-ingest.hexly.ai 入口已补失败用例并实现，只开放 Bearer 上报/心跳与健康检查，其余路径 404。尚待部署。
- 已发起真实 Access 登录，等用户在浏览器完成认证后执行生产认证页面验收；不请求用户提供 Token。


## 2026-09-19 15:24 +08:00（发布前复核）

- 最终门禁：33 项单元/集成测试、10 项桌面/手机浏览器测试、TypeScript、Biome、生产构建全部通过。
- 15:23 本地真实免登录端到端复验通过。自动更新通过 machine-heading 的语义 time 元素核对精确 capturedAt，避免误把页面时钟当作新快照。
- 首屏采用彩色状态指标、需关注/进行中优先的紧凑 Space 拓扑、右侧变化流与证据覆盖；多 Tab 并排展示，手机统计收为一行。动效支持 reduced-motion，后台刷新保留内容。
- Grok 确认专用 ingest host 没有可复现绕过。其停止 Session 计数推测已通过 summarize 实际运行反证：即使 Pane 的证据齐全，unavailable Space 仍为 unverified。
- 正在部署，并将本机上报入口切换到专用域名、清理旧 viewer secret。真实 Access 用户登录尚待完成。


## 2026-09-19 15:31 +08:00（Access 改版，第二个 15 分钟）

- 已整合 main 上独立发布的鹰标识、品牌链接和健康版本字段，保留双方变更；Grok 已收回停止 Session 的误报，无可复现 P0/P1。
- 15:30 本地真实免登录端到端复验通过：当前 Herdr 为 14 Space / 28 Pane，采集、Bearer、D1、全量渲染、自动刷新、详情、历史、桌面与手机均通过，无浏览器错误。
- 冷启动测试发现 Vite 延迟发现 Radix 的 react-dom peer 导致依赖 504，已预加载该依赖；清空测试缓存后的 12 项桌面/手机用例通过，33 项单元/集成测试及类型、Biome、构建通过。
- 真实 Access 用户登录已成功。旧 VIEWER_TOKEN 已从 Worker secret 和本地安全配置删除，机器 Bearer 保留。
- 当前生产断点：新增采集域名尚未可解析；积压快照仍安全保留在 spool。正在核对域名绑定并部署整合后的确切提交，再验证生产登录与补传。
