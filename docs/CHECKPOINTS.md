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


## 2026-09-19 15:40 +08:00（真实生产验收）

- `fcadf5d` 已推送 main、GitHub CI 全绿并部署；真实 Access 会话在 15:37 完成生产端到端验证。14 Space / 28 Pane 从真实 Herdr 采集，经机器 Bearer、D1 到桌面/手机全部渲染；幂等、自动刷新、详情、历史及无浏览器错误均通过。
- 生产匿名看板请求 302 到 nocoo Access；独立采集域名的页面、资源、overview、history 均为 404，未认证 reports/heartbeat 为 401。公开健康检查包含 0.1.1 与完整 Git revision。
- DNS 问题来自 Mihomo 和系统的负缓存；清理 Mihomo 缓存后公网解析正常，Node 采集器已跟随本机现有 HTTPS 代理。spool 已清空，15:38:12、15:38:42、15:39:12 连续成功上报，均无采集告警，错误日志没有新增。
- Worker 只剩 AGENT_TOKENS secret；旧 viewer 文件及安全 JSON 字段已删除，机器安全配置保持 0600。
- 最终复核新增失败用例：请求失败不得继续显示“已同步”。桌面和手机均先复现，随后改成红色断线提示并保留上次快照；正执行最后复验与部署。

## 2026-09-19 16:06 +08:00（侧栏框架，本地预览）

- 参照 Ellie、Giraffe，桌面侧栏默认展开，PanelLeft 控制折叠，底部使用 Basalt SidebarUser / Avatar 展示账户与退出登录。真实浏览器确认两种状态的 Logo 均为 x=22、y=16、24×24；手机抽屉开关、真实头像加载及本地退出不可用均通过。
- `/api/v1/me` 从验证后的 Access JWT 获取邮箱，以 SHA-256 查询既有头像服务，不转发凭据、不入库。本地通过安全配置指定预览邮箱，仍然无须登录。服务失败回退姓名和首字母头像。
- 16:04 本地真实端到端通过：12 Space / 21 Pane，从 Herdr 采集、Bearer 上传、D1 到全量页面；幂等、自动刷新、详情、历史、桌面和手机均通过，无浏览器错误。16:06 本地每 30 秒采集已启动，首轮成功，无采集告警。
- 新增测试先复现旧侧栏行为、缺失身份接口及发布 CSP 阻止外部头像，再完成修复。最终 34 项单元/集成、18 项浏览器测试、TypeScript、Biome 与构建通过。
- 已打开 https://eagle.dev.hexly.ai。此次按要求交付本地预览，尚未将该批框架改动部署到生产。

## 2026-09-19 16:31 +08:00（端口纠正、机器资源与关注端口）

- 查询 nmem 确认 6001 属于历史 eagle-webui，最新项目序列为 Archy 7051、Zeppelin 7052。核对注册记录、两份 Caddyfile 和可绑定性后，为当前 Eagle 分配 7053 / 37053（Worker）/ 38053（inspector）/ 17053（API E2E 预留）/ 27053（浏览器）。项目配置、文档、活跃及 workflow Caddyfile 已同步；Caddy validate/reload 与 HTTPS 200 通过，分配记录写入 nmem `eagle-local-ports`。
- 16:21 直接 SQL 核验：线上 Cloudflare D1 `eagle` 已有 235 份报告，最近写入 16:21:16；独立本地 D1 当时有 60 份报告。生产原有采集持续运行。
- 采集器增加 CPU 使用率/型号/核数/负载、内存、主目录文件系统容量/可用空间和 uptime；`watchPorts` 可配置最多 32 个本机 TCP 端口，已在本地启用 Raven 7024。当前真实探测为未监听，不等同于线上 Raven 服务状态。
- 16:30 本地 D1 SQL 直接读出最新快照的 18 核、128 GiB、Raven 7024 与 closed 状态。新增字段保存在原有 reports.payload，无需表迁移；旧 v1 报告仍有效，缺失/过期数据不显示为当前正常。
- 16:30:55 真实端到端验证通过：11 Space / 20 Pane + 资源和关注端口，从采集、Bearer、幂等、D1 到全量页面/历史/自动刷新与桌面手机均通过；无页面错误或横向溢出。38 项单元/集成、20 项浏览器测试及类型、Biome、构建通过，新增用例先失败后实现。
- 本地持续采集已恢复，预览域名不变。此次未部署新增字段；发布顺序已写入 Agent 文档：先部署兼容 Worker，再重启生产采集器。

## 2026-09-19 16:45 +08:00（每机 DO 当前状态，本地验收）

- 按最新指示暂缓每小时总结及 D1 归档，本轮没有新增 Cron 或 D1 Migration。已有历史只读保留。每台已配置机器对应一个 SQLite Durable Object，保存当前全量快照、心跳、告警、revision 和最近一次变化摘要；回执只存 ID、摘要哈希和序号，不存历史报告。
- 严格 TDD 先复现上传仍写 D1、首页依赖历史、队列先补旧状态，以及健康接口缺失新存储标识，再完成实现。42 项单元/集成测试和 22 项桌面/手机浏览器测试通过；类型、Biome、构建通过。覆盖 DO 驱逐恢复、并发首次上传、重复/冲突、乱序、Space 关闭、告警保留和旧历史表不可用时当前链路仍正常。
- 16:44 真实本机 11 Space / 20 Pane 的端到端通过：Herdr → Bearer → DO → 页面，资源、Raven 7024、自动刷新、稳定 DOM、Pane 证据、既有历史和手机布局均验证；无浏览器错误。Raven 7024 当前仍未监听。SQL 复核本地 D1 前后均 83 条，最后写入仍为 16:36:50，说明新上传未进入 D1。
- 首页直接读取 DO 当前变化，取消按报告刷新 D1 历史。仅首次加载显示骨架，刷新保留原卡片；进度条延迟出现，拓扑位置平滑过渡，减少动画偏好生效。Agent 队列优先最新快照，旧上报不能回滚 DO。
- 下一步：部署已验证的当前状态架构，先发布兼容 Worker，再更新并恢复生产 Agent，验证真实 Access 和线上 DO。

## 2026-09-19 17:08 +08 — 本地总览分层与 Connect

- 用户视角：全局页只展示全部机器汇总、状态分布与资源图；进入机器后展示资源、端口与 Space，顶部汇总卡片不再重复。Connect 已可新增机器、生成接入提示词、重命名、轮换及停用凭证。
- 真实检查（17:07:58）：本机 12 Spaces / 21 Panes 完整采集，Bearer 认证成功，幂等重试成功，DO revision 前进，Caddy `https://eagle.dev.hexly.ai` 桌面和手机均渲染通过；刷新卡片 DOM 保持，历史查询正常且没有新增 D1 写入。
- Token 采用签名凭证，签名密钥只写入本地安全配置；每个机器 DO 仅维护凭证版本和机器配置，Token 不入库，页面预览隐藏 Token。
- 下一跳：从 Connect 生成凭证，用仓库外安装的 npm 包上报真实机器数据，验证轮换与停用。网站和 npm 暂未发布，生产采集器保持运行。

## 2026-09-19 17:20 +08 — Connect 本地验收完成

- 17:09:59 真实 Connect 验收通过：页面创建验证机、复制含一次性 Token 的提示词、仓库外安装 npm tarball、采集本机 12 Spaces / 21 Panes 并写入独立 DO；轮换后旧凭证 401，新凭证仍能上报，停用后新凭证也返回 401。桌面和手机无浏览器错误或横向溢出，预览不显示 Token、浏览器存储无凭据。
- Grok 只读 Review 提醒轮换时保留已有配置；已将关注端口纳入机器配置，提示词明确核对 machineId 后仅替换 Token，禁止覆盖 evidenceFile、端口及其它设置。集成者另外补测旧机器迁移：移除旧 AGENT_TOKENS 配置后仍能从独立机器目录找到已迁移机器。
- 最终本地 45 项单元/集成、26 项桌面/手机浏览器测试、TypeScript、Biome、构建全部通过。npm 包在临时目录独立安装并运行 init/帮助已通过，实际 npm 安装包的上报链路也已验证。
- 17:17 SQL 复核：本地 D1 仍为 83 条，最新写入仍为 16:36:50.785。新机器管理和当前状态没有写入 D1。测试机器已停用，本地正式采集恢复每 30 秒运行，生产 LaunchAgent 未停止或更新。
- 网站与 npm 包都保持本地预览，未部署或发布。

## 2026-09-19 17:31 +08 — Agent npm 首次发布

- `@nocoo/eagle-agent@0.3.0` 已公开发布到 npm，发布源码为 `23880d7`。精确 tarball 只包含 6 个编译后的 JS 文件、package.json 和安装说明；官方 registry 的 SHA-512 integrity 与发布前检查的包一致。
- Connect 提示词、npm README、仓库安装文档和 eagle-report Skill 已写明 Node 24+ / Herdr 前提、官方源下载、npm 连不上时首选腾讯云 HTTPS 镜像、固定版本验证及镜像同步延迟处理。只对单条命令指定 registry，不改全局配置。
- 官方源以全新缓存独立安装成功；腾讯镜像已同步 0.3.0，校验值一致，未使用 npm 登录凭据的全新全局安装也成功。两种安装的 `--version` 均为 0.3.0，`--help` 正常。
- 17:30:17 从官方 npm 下载的 Agent 完成真实 Connect 验收：本机 11 Spaces / 20 Panes，经签名 Bearer 上报到机器 DO；轮换后旧 Token 401，新 Token 能上报；停用后新 Token 401。Raven 7024 配置保留，桌面与手机渲染、浏览器无凭据持久化均通过；验证机已再次停用。
- SQL 复核本地 D1 仍为 83 条，最近写入仍为 16:36:50.785，新上报没有写入 D1。新增提示词检查先失败再通过；45 项单元/集成/安装测试、26 项浏览器测试、类型、Biome 和构建全部通过。
- 本轮只发布 npm Agent。网站改动继续在 https://eagle.dev.hexly.ai/connect 预览，Worker 未部署，生产采集服务未更新。
