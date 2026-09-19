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
- 首轮 GitHub CI 揭示移动端刷新测试把尚未结束的 2px 悬停动画误判为布局变化；测试改为先把指针移到刷新按钮、等待卡片动画完成再测量，保留原来的严格坐标和 DOM 连续性断言。桌面/手机该用例各重复 5 次均通过，完整本地门禁再次通过；发布包内容未变化。

## 2026-09-19 17:58 +08 — Pane 语义通道实施检查点

- 本机真实 Caddy API 确认 11 Spaces / 21 Panes，最后快照 17:58:00；daemon → Bearer → DO 的持续链路正常。
- summary v1、task/evidence 绑定、sequence 幂等与独立 D1 摘要表已完成首轮 Miniflare 测试；采集器旧 manager 文件不能再冒充 Git/测试/部署证据。旧报告历史仍暂停写入。
- 真实语义链路尚未接通：本地 API summaries 为 0，Migration 尚未应用、Manager CLI 和页面展示正在实现。本检查点不算语义能力验收。
- 下一跳：完成持续 Manager、处理总结期间事实变化、接入 Pane 摘要与时间线，再用本机所有 live Pane 验证。

## 2026-09-19 18:13 +08 — 独立语义流与 UTC 小时契约

- 真实 Herdr 库存已变化为 9 Spaces / 18 live Panes，0.4.0 daemon 于 18:12:52 经 Bearer 成功更新本地 DO。先前 Cherry 已实际覆盖全部 18 个 live Pane，并出现 interpreted=0 的纯核对轮次，未每 30 秒调用模型。
- 按用户补充将语义历史改为 DO 独立 SQLite 记录，按 observedAt 的 UTC 小时桶分组；D1 仅作不可变副本。小时 latest/all 查询、迟到旧任务不覆盖当前任务、跨 DO 驱逐恢复、幂等与桌面/手机展开测试通过。
- 重构后的本地 DO 语义表目前为空；旧开发态总结已在 D1，新的真实 Cherry 验收尚在进行。Review 发现 cache 与 DO 缺失状态可能持续 409，已先复现再修复为缓存补传；同时修复新任务复用旧 previous 和 cooldown 的问题。
- 当前下一跳：用更新后的持续 Manager 重新填满全部 live Pane，验证 DO 小时记录→页面→D1副本，再进行完整 Review、CI 和生产发布。每小时 AI 聚合保持暂停。

## 2026-09-19 18:21 +08 — 全 Pane 本地验收与发布门禁

- 18:16 真实 Caddy 验收逐一打开 9 Spaces / 18 live Panes，18 个均有 Cherry 当前任务语义总结；每个 Pane 的 UTC 小时分组、latest/all、来源与 64 位内容哈希均核对成功。桌面/手机无溢出或脚本错误，自动刷新保留同一总结 DOM。
- 同轮原有 verify-live.ts 验证完整采集、Bearer、DO、资源/端口、幂等、自动刷新和历史读取全部通过。新语义模型有 interpreted=0 的心跳轮次；真实变化后继续产生多条小时记录。
- Grok 只读 Review 的缓存补传、旧任务 previous、409 心跳冲突与证据保留问题均已修复；语义存储改为独立 SQLite 表和已知事实索引。补充测试验证迟到观察不能回滚当前指针、latest 查询拒绝 cursor、观察超出保留期拒绝，以及含分隔符的 ID 不会串绑。
- 当前 55 项单元/集成测试、30 项浏览器测试、类型、Biome 和构建通过。生产 D1 0002 已应用，Connect 签名密钥已写入 Worker 安全配置，真实 Access 会话有效。网站与生产 Manager 的正式切换即将进行；npm 0.4.0 待发布认证。

## 2026-09-19 18:28 +08 — Review 修复与连续运行复验

- 18:28:31 再次通过真实 Caddy 验收：9 Spaces / 18 live Panes 均有当前任务总结，逐 Pane 展开 UTC 小时全部记录，核对 latest、来源、内容哈希与 sequence；桌面、手机和刷新 DOM 连续性通过。
- 真实安静 Pane w3J:p3 的语义更新时间保持 18:13:54，检查时间推进至 18:28:08，该 UTC 小时仍仅 1 条记录，证明持续 heartbeat 没有重复写历史。daemon 最近快照 18:28:03，Manager sequence 已到 42；本地 D1 副本已有 46 条、18 个不同 Pane（18:22 查询）。
- Grok 第二轮 Review 后先补失败用例：同 Pane 不同 task 可独立上报；错误条目被隔离后有效条目立即续传；当前 live task 指针不被历史保留策略清理。三个问题均已修复，57 项单元/集成、30 项浏览器测试、TypeScript、Biome、构建通过。
- 下一跳：当前修复提交通过 CI 后部署 Worker，重启生产确定性 daemon 并启用独立 Cherry Manager，验证生产 DO、D1 语义副本与全 Pane 页面。npm 0.4.0 已遇 EOTP，等待新的发布验证码；网站发布不依赖 npm 验证码。

## 2026-09-19 18:38 +08 — 生产真实 Cherry 验收

- `4a156928092969e4efa919a805ba41183b415bfe` 通过 GitHub CI（run 35437633317），部署到 https://eagle.hexly.ai；Cloudflare Version ID 为 `3e06045b-4ddf-4cc2-a830-b4ce41478c13`。线上健康接口返回相同源码 revision、semanticStore=durable-objects、semanticHours=UTC。
- 18:33:40 生产 verify-live.ts 通过真实 9 Spaces / 18 Panes 的采集、Bearer、DO、资源/关注端口、幂等、Access 登录、全 Space 渲染、稳定刷新、旧历史与桌面/手机检查。整机快照没有继续写 D1。
- 已启用独立 LaunchAgent `com.hexly.eagle-manager`，使用现有 Cherry profile；原 daemon 更新至 0.4.0 并继续每 30 秒运行。18:36:32 生产 verify-summaries.ts 逐一展开全部 18 个当前任务总结及小时记录，latest/all、source、content hash、桌面/手机与 DOM 连续性全部通过。
- 远程 D1 实查 18 条语义副本、18 个不同 Pane，最新收件 18:35:35；DO 中同一 UTC 10:00 小时有 18 条记录。安静 Pane w3J:p3 的语义更新时间保持 18:33:48，检查时间从 18:35:11 推进到 18:35:41，内容哈希不变、小时仍仅 1 条。生产曾遇短暂 fetch 断连，持久 pending 批次重试成功，没有清除状态或重新创建 sequence。
- 本机已从校验过的发布 tarball 安装 0.4.0，`eagle-agent --version` 与 manager-once / manager-watch 帮助验证成功。npm registry 的 0.4.0 发布仍被 EOTP 阻止，尚未取得新的验证码；因此其它机器暂不能从 registry 安装此版本。Skill 和安装说明已备妥，待验证码后发布相同包并校验腾讯镜像。

## 2026-09-19 18:59 +08 — npm 0.4.0 与布局预览

- npm 已接受 `@nocoo/eagle-agent@0.4.0`，官方 registry 已返回该版本；SHA-512 与此前测试的 tarball 完全一致。正在以全新缓存验证官方源及腾讯镜像安装，网站布局仍在本地收尾。
- 18:57:31 真实 Caddy 验证通过：9 Spaces / 17 live Panes，采集、Bearer、幂等上传、DO revision、CPU/内存/磁盘/Raven 7024、全部 Space 渲染与稳定自动刷新正常。桌面和手机无浏览器错误；本地 daemon 已恢复。
- 本地 D1 SQL 复核旧快照仍为 83 条，最新时间仍为 16:36:50.785，没有恢复整机快照归档。语义通道与生产 Manager 未改动。
- 用户可在机器页看到压缩后的状态头部，资源卡已移到右侧「02 运行脉搏」上方；手机资源卡在拓扑之前。按钮问题先由浏览器测试复现：保存/取消文字换行、证据按钮高度仅 16px、复制提示词缺少按钮内文案。修复后桌面/手机对应 6 项回归通过。
- 下一跳：审查多宽度按钮与实际预览，完成网站 v0.2.1 门禁、CI、部署和生产验证。
- 18:59 npm 复验完成：官方源与腾讯镜像均使用全新缓存安装成功，tarball integrity 相同，CLI `--version` 为 0.4.0，`manager-once` / `manager-watch` 均存在。`agent-v0.4.0` 已指向发布源码 `4a15692` 并推送。
- 发布前布局复查覆盖 390 / 520 / 768 / 1024 / 1280 / 1600px：修复中等宽度下固定列数挤压多 Pane 按钮的问题，按实际可用宽度自动排列 Space；真实页面所有按钮无横向内容溢出。最终 57 项单元/集成、34 项浏览器、TypeScript、Biome、构建全部通过。人工 diff Review 核对原生 Basalt 控件、Token 内存生命周期、独立复制反馈、过期提示与 DOM 连续性，未发现发布阻断项。
- 19:01:50 最终 Caddy 实测时库存已新增为 10 Spaces / 18 Panes；完整 verify-live 再次通过，daemon 恢复持续上报。

## 2026-09-19 19:11 +08 — Agent 中立接入修正

- 根据另一台机器的真实失败报告，移除隐式 `cherry` 可执行文件默认值。语义层要求显式 `manager.command`，推荐已配置的 Hermes，也支持任何满足 stdin/stdout 契约的管理 Agent；缺少配置时快速说明处理方式，不影响独立 daemon。
- Onboarding、npm README、项目 Skill 和双语文档同步说明：Cherry 是本机 Hermes 别名/profile，不能据此寻找或安装同名产品。已核验本机 Hermes CLI 参数与官方项目来源；保留原模型/provider/profile，禁用工具，其他 Agent 采用自身已验证接口或适配器。
- 两项 Manager 行为测试先失败再通过：未配置命令时不发网络请求；独立非 Cherry 子进程从 stdin 获取脱敏输入并成功上报自己的 writer ID。包测试确认 manager-once/watch 未配置时立即退出且不泄露 Token。59 项单元/集成、34 项浏览器、类型、Biome、构建及 Skill 校验通过。
- 19:10:48 真实 Caddy 验证 10 Spaces / 18 Panes，采集→Bearer→DO→资源/拓扑→稳定刷新通过，旧 D1 历史未增加。本机安全配置已显式保留原 Cherry profile 命令和 writer ID，未重置 sequence。
- 网站 v0.2.1 的布局提交 CI 已通过；曾因同一工作区正在进行 README 整理而被部署脚本拒绝，没有产生不明确的线上 revision。该文档整理现已单独提交。新的 Agent 0.4.1 包已准备并等待 npm OTP；本轮修正提交通过 CI 后部署网站。
- 19:14:09 生产语义复验逐一展开 18/18 live Pane 与 UTC 小时 latest/all，来源、内容 hash、sequence、桌面/手机、DOM 连续性全部通过。当前代码提交 `b51becd` CI 全绿（run 35439452296），Manager sequence 已持续到 66。
- npm 0.4.1 发布等待用户提供新 OTP。为独立完成网站部署，Connect 与公开安装步骤暂时固定已发布的 0.4.0，并显式配置其已支持的 manager.command；因此新提示词不依赖未发布版本。0.4.1 tarball 和源码已单独留存待发布。

## 2026-09-19 19:21 +08 — 网站 v0.2.1 发布验收

- `c19801bd65b3d0648a3f01e9ccfd6acbee365386` 已部署到 https://eagle.hexly.ai，Cloudflare Version ID `76756438-c2cb-4865-8c7d-9c9ac2a62ab9`。`/api/live` 返回 v0.2.1 和对应 revision；该提交 CI 全绿（run 35439643975）。Git tag / GitHub Release `v0.2.1` 已发布。
- 19:19:47 生产 verify-live 完成真实 10 Spaces / 18 Panes 的采集、Bearer、DO、资源和关注端口、幂等、Access 匿名跳转/会话、全部 Space、旧历史及桌面/手机验证；自动刷新保留原 DOM，整机快照仍不新增 D1 历史。daemon 已恢复并持续上报。
- 19:20:44 在新网站逐一展开 18/18 live Pane 语义总结与 UTC 小时时间线，latest/all、来源、内容 hash、sequence、 freshness 和刷新连续性全部通过。生产 Manager 沿用原 profile/writer ID，sequence 连续推进，仍出现 interpreted=0 的稳定心跳轮次。
- 线上静态资源烟测确认资源卡位于运行脉搏上方、版本 pill 正确、重命名按钮不挤压。对凭证创建响应作浏览器内桩替换以检查复制 UI，没有创建生产机器或修改生产凭证：按钮内“已复制提示词”、宽度不变、手机无横向溢出、浏览器存储无凭证均通过。实际部署的提示词为 Agent 中立、推荐 Hermes、显式 manager.command，下载固定已发布的 0.4.0。
- npm 0.4.0 已发布并验证官方/腾讯安装；0.4.1 默认行为修复已完成 59 项单元/集成和 34 项浏览器门禁，发布 tarball 源码为 `b51becd`、SHA-1 为 `df0ecee674dc8a80844b70fb94f58800aae65ef9`，仍等待新的 npm OTP，尚未声称发布。
- 已设置发布后 5 分钟 CI 复查；本轮网站部署完成，npm 验证码待补。

## 2026-09-19 20:09 +08 — Sidebar lights and hourly-report baseline

- User view: dev sidebar now has glowing online/stale/offline indicators in expanded, collapsed and mobile layouts; 38 browser checks passed before hourly-report work.
- Real local path verified at 20:08:45: 10 Spaces / 19 Panes collected, Bearer upload accepted into the machine DO, duplicate upload idempotent, resources/ports rendered, auto-refresh kept DOM stable. Local viewing remains token-free.
- D1 old whole-snapshot writes remain paused; local migration 0003 adds a separate AI hourly-report archive. No model is configured yet, so generation explicitly skips.
- Next hop: finish next-ai settings/report UI, exercise complete generation and retry against isolated Miniflare/D1, then review and release v0.2.2. Evidence: `.local/hourly-baseline-live.log`.

## 2026-09-19 20:27 +08 — Hourly report flow and dev preview

- Dev user view: Basalt AI settings and Chinese report history render on desktop/mobile; all 42 browser checks passed before final review fixes. Hour reports keep expanded content mounted on refresh.
- Real local upload and initial rendering succeeded (10 Spaces / 19 Panes). A refresh assertion raced the running daemon, so the verifier now accepts the submitted timestamp or a newer one while requiring revision advancement and stable DOM. The corrected real verification passed at 20:28:10. Legacy D1 snapshot writes are still paused.
- Migration 0003 is applied locally. `verify-hourly.ts` confirms the real settings API is non-secret, unconfigured generation skips, and D1 hourly history is queryable. A configured provider simulator with real Miniflare/DO/D1 verifies independent semantic times, concurrent leases, same-hour upserts, late input, upstream failure and protected generated-result retry.
- Grok read-only review found chronological pagination, catch-up cadence, partial-report validation, pending retention and deferred-result messaging issues. Corrected; final regression and v0.2.2 release verification follow. No production AI credential has been configured.

## 2026-09-19 20:38 +08 — UI credential storage and final local verification

- Following the user's clarification, Settings now saves/replaces/tests/clears API keys in the browser form, without returning plaintext or storing it in browser persistence. AES-GCM ciphertext lives in the directory DO's independent credential record; the wrapping key lives in Worker secrets. Changed provider/endpoint cannot reuse the previous key.
- TDD first reproduced rejection of UI key saves. The final 66 unit/integration tests and 44 desktop/mobile browser tests pass, including raw SQLite inspection for absence of plaintext, authenticated encryption, DO eviction recovery, draft testing without saving, endpoint binding and hourly generation using the saved credential.
- Real Caddy verification at 20:38:16 saved a temporary validation credential through the page, reloaded its configured status, cleared it and restored the original settings, without calling an AI provider. It also verified unconfigured skip, D1 hourly queries, settings/history rendering and mobile layout. The first attempt identified a dev Worker missing the new wrapping-key binding; restarting it resolved the failure.
- At 20:38:22, real Herdr collection again verified 10 Spaces / 19 Panes through Bearer, machine DO, resources/ports, all-Space rendering and stable automatic refresh. Raw D1 snapshot writes remain paused. Next: finish credential review, apply production migration, release v0.2.2 and verify both real production paths.
