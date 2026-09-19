<p align="center"><img src="assets/brand/readme.png" width="128" height="128" alt="Eagle 金色鹰 Logo" /></p>

# Eagle

[English](README.md) · [网站](https://eagle.hexly.ai) · [Hexly 档案](https://hexly.ai/projects/eagle) · [服务状态](https://status.hexly.ai)

汇总多台上报机器上的 Herdr Space、窗格布局、任务证据与历史。私有看板只展示有据可查的状态；缺失或过期数据明确标记，不把 Agent 的 `done` 等生命周期提示当作任务完成证明。

## 运行与架构

前端使用 React 19、Vite 与 Basalt；Cloudflare Worker 提供页面和受认证保护的 API，每台机器一个 SQLite Durable Object 保存当前状态；D1 保留既有历史，新归档与每小时 AI 总结暂缓。本地 Node 管理 Agent 负责采集、脱敏、排队与幂等上报。没有远程终端控制入口。

网站由 nocoo 团队的 Cloudflare Access 保护，本地免登录。机器使用独立 Bearer Token，向 `https://eagle-ingest.hexly.ai` 上报；该域名不开放看板、查询或历史。

桌面侧栏默认展开，展开与折叠时 Logo 位置固定。底部显示 Access 账户、头像服务返回的姓名与头像，以及退出登录按钮。头像查询只发送规范化邮箱的 SHA-256；服务不可用时保留姓名和首字母头像。本地可在 `.dev.vars` 配置 `LOCAL_USER_EMAIL` 预览真实头像，无须 Token，退出按钮显示为不可用。

需要 Node 24+、npm、Herdr 0.9.1+。凭据仅保存在安全配置中，不写入源码、浏览器存储或上报数据。具体认证与部署步骤以 [English README](README.md) 和 [Agent 契约](docs/AGENT.md) 为准。

```sh
npm ci
npm run db:local
npm run dev:api
# 另开一个终端
npm run dev
```

日常访问 `https://eagle.dev.hexly.ai`。Vite / Worker 端口为 7053 / 37053，浏览器测试使用 27053，独立 API 测试保留 17053。开发、测试和生产数据相互隔离。

端口已按 nmem 最新序列分配到 Zeppelin 7052 之后；6001 属于历史 eagle-webui。Worker inspector 为 38053。

每台机器还会上报 CPU、内存、主目录所在磁盘容量和运行时间。在采集器安全配置中增加 `"watchPorts":[{"name":"Raven","port":7024}]`，即可检查指定本机 TCP 端口。数据与 Space 当前快照一起保存在该机器的 DO；端口可连接不等于应用业务健康，过期结果明确显示为历史。配置与升级顺序见 [Agent 契约](docs/AGENT.md)。

## 如何理解工作态势

看板在可见时每 5 秒刷新，重新可见时立即刷新。心跳超过 90 秒或快照超过 5 分钟，会明确显示过期。刷新失败保留最后已知数据，并显示连接警告。

已验证任务要求当前任务总结、Goal、Git revision 与测试证据相互一致；任务涉及部署时还需要部署证明。证据不一致、过期或缺失不会变成完成状态。Codex 适配器只提取最终回复和生命周期事件，不采集推理或工具参数。

采集器对文本证据脱敏，但启发式处理不能保证识别任意秘密。管理 Agent 应上报简明摘要和结构化验证凭证，避免原始终端转储。具体上报方法见 [eagle-report Skill](skills/eagle-report/SKILL.md)。

## 验证与发布

```sh
npm run check
npm run test:browser
npm run deploy
```

发布从已提交的源码构建，公开 `https://eagle-ingest.hexly.ai/api/live` 探测第一台已配置机器的 DO并报告当前版本和完整提交，不泄露机器清单。真实机器、DO 与页面链路的验证方式见 [检查点](docs/CHECKPOINTS.md) 及 `scripts/verify-live.ts`。

## 标识

金色鹰采用动物系列的连贯平面切面，鹰喙轻衔一条多色飘带。README 使用圆角展示图；展开与收起的侧栏、加载及身份入口使用透明前景，不加背景底板或圆角遮罩。根目录 `logo.png` 是 2048px 透明主文件，来源与角色详见 [品牌记录](assets/brand/provenance.json)。网站保留独立的 Basalt 色板。
