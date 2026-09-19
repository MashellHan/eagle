# AI 小时报告

Eagle v0.2.2 在每台机器的确定性采集与 Manager 语义流之上生成独立的中文小时报告。原始快照仍不写入 D1；D1 保存生成完成的报告，现有 Pane 语义存档不变。

## 设置与凭据

侧栏「设置」复用 `@nocoo/next-ai@0.4.0` 的提供商注册表、配置解析和 PromptTemplateRegistry，控件全部使用 Basalt。默认开启自动生成，间隔 1 小时，可选 2/3/6/12/24 小时；每个 UTC 小时始终单独成稿。

设置页可输入、替换和清除 API Key；留空保留已保存密钥，保存后清空输入框，只返回 `hasApiKey`，不回显原文或后缀。测试连接可以使用未保存的草稿密钥，不会自动保存。切换提供商、API 地址、接口协议或认证方式后需重新输入密钥；草稿测试也不能把已保存密钥发到另一地址。

密钥以 AES-256-GCM 加密，随机 12 字节 IV，并以版本、应用名、提供商/地址/协议/认证方式作认证附加数据。目录 DO 的独立 KV `ai-credential` 保存 `{version:1,endpoint,data}`；明文不进入非密设置、机器状态、D1、日志或浏览器持久存储。加密主密钥是 Worker secret `AI_ENCRYPTION_KEY`（至少 32 字符）；本地使用 gitignored `.dev.vars` 同名配置。主密钥丢失或改变会令既存凭据无法解密，不能在部署时自动覆盖。设置页同时编辑模型、公开 HTTPS 地址、协议和认证方式。未配置完整 AI 或关闭自动报告时跳过，不调用模型。

OpenAI 兼容接口使用 Chat Completions；Anthropic 使用 Messages。next-ai 0.4.0 的工厂未暴露 transport 且 Bearer 会同时发送 x-api-key，Eagle 复用其解析器，使用相同底层 AI SDK 配置单一认证头并拒绝重定向，避免密钥跟随跳转。上游错误正文不会进入日志、API 或报告。

## 小时输入和生命周期

- `current` 仍是最新确定性状态，`semantic_records`/`semantic_current` 仍是独立语义流。两路不要求时间对齐，也不互相覆盖。
- 每台机器 DO 新增 `hourly_facts(seq, report_id UNIQUE, hour, captured_at, payload)`，接受去重后的报告，按 `capturedAt` 归 UTC 桶，包括晚到但有效的采集。索引 `hourly_fact_hours(hour,seq)`。这只是生成报告的短期输入，保留 48 小时；旧快照不会覆盖实时状态。
- 语义输入读取同小时全部 `semantic_records`，以 `observedAt` 归桶。合并相同事实时保留所有观察时间；闭合的 Space/Pane、旧 taskId、资源与端口采样继续参与总结。
- 每小时 `05` 分触发 Cron，为已结束且过了 5 分钟缓冲期的小时生成报告；间隔大于 1 小时会处理多个独立小时。未完成输入保留在 DO 内，较长生成间隔只限制新小时进入，已到期积压在每次 Cron 都可继续处理；下一次调度或设置页「补生成已结束小时」可重试。
- `hourly_jobs(hour PRIMARY KEY, version, lease, expires, pending, completed_version, last_error)` 跟踪输入版本、14 分钟租约、生成结果与失败状态。单次模型调用 90 秒超时、输出上限 16,384 tokens，单个报告 10 分钟预算，整轮 12 分钟预算；超出预算推迟余下任务。错误日志仅含机器、小时、失败分块/合并阶段和错误类别，不打印模型原文。
- 重复上传不会增加小时输入；重复生成不会重复调用模型。版本格式为 `templateVersion:factCount:factMaxSeq:semanticCount:semanticMaxSeq`，48 小时窗口内的新事实/新语义或模板升级会重新生成并更新同一小时报告。D1 写入失败时先保留 `pending`，下次复用结果；新输入或模板版本到达时失效旧缓存。已生成但尚未入库的结果即使超过 48 小时也受保护，继续以原元数据尝试入库。
- 常见小时输入按内容去重；较大输入分块按同一固定模板整理、逐块校验引用后生成最终报告，不静默截断。原始事实通过 SQL 游标逐条压缩，不先把完整小时快照读入内存。超过 32 个输入块或单条 180,000 字符时明确失败并保留待处理状态，避免阻塞实时上报和生成不完整报告。

## 模板与证据

dev 模板版本 `eagle-hourly-zh-v3`（v0.2.2 生产仍使用 v1），中文固定七节：本小时总览；Space 与 Pane 进展；成果、测试、提交与部署；机器资源与关注端口；真实阻塞与待核实事项；下一步行动；判断依据与数据覆盖。

每节均为非空中文文本，输出严格 JSON 校验。报告携带输入内容指纹、模型、模板版本、采集/语义记录数量、两路数据覆盖起止和引用的原始记录 ID。Git、测试、进程与部署事实优先于 Manager 推断；`blocked/idle/done` 不能证明结果。旧证据、未知、断连或不足一小时覆盖必须明确说明。AI 的报告本身仍是解释，不覆盖原始证据。

总览目标 120～220 字，prompt 要求不超过 400 字；超过 400 字时仅追加一次摘要压缩，最终校验上限 600 字，保留对模型字数偏差的容差。其他章节不参与改写，非法 JSON、未知引用或 token 截断均直接失败，不存不完整报告。按 Space/Pane/task 合并重复说明；稀疏资源采样不外推连续状态或故障时长。材料指令不执行、不回显。实质结论就近引用 `[F2]` / `[S4]`，内联 ID 必须存在于原始输入；合法引用若漏列于 evidenceIds，由代码补齐索引，不再调用模型。输出类型示例固定七个文本字段加一个 evidenceIds 数组。v3 还要求保留嵌套 evidence 的原始时间，新 Manager 时间不刷新旧 CI/错误状态；历史阻塞只作待核实线索，取消任务不自行建议重开。真实 dev eval 的样例、局限与重跑命令见 [HOURLY-EVAL.md](HOURLY-EVAL.md)。

## API 与 D1

所有接口仅允许网站的 Cloudflare Access 身份（本地免登录），Agent Bearer 不可访问；ingest 域名不暴露设置或历史接口。

- `GET /api/v1/settings`：非密设置、`hasApiKey`、`configured`、模板版本与章节。
- `POST /api/v1/settings`：局部更新设置；可选 `apiKey` 非空字符串用于替换，省略或空字符串保留，`null` 清除。设置与加密凭据原子保存；未知字段拒绝。
- `POST /api/v1/settings/test`：草稿配置和可选草稿 `apiKey` 测试连接，否则只复用同提供商/地址/协议/认证方式的已保存密钥。不保存草稿，不返回模型原文或密钥。
- `POST /api/v1/hourly-reports/run`：可选 `{machine, hour}`；hour 必须是 48 小时内已关闭的标准 UTC 小时。无指定小时则补处理待生成小时，返回逐机器结果或明确的跳过原因。
- `GET /api/v1/hourly-reports?machine=...&hour=...&limit=12&before=...`：机器/小时可选，返回 `{entries:[{seq,report}],nextCursor}`；游标是不透明值，原样传回。

Migration `0003_hourly_reports.sql` 新增 `machine_hour_reports`，唯一键 `(machine_id,hour)`，索引支持机器/全局小时查询。报告保存至 D1 后长期保留，不随 48 小时输入清理删除。现有 `/api/v1/history` 继续提供旧版原始快照，新「最近历史」页面先展示小时报告，可按本地小时筛选和展开固定章节。

## 验证

`tests/hourly.test.ts` 覆盖加密认证、UTC 边界、闭合 Pane、独立语义时间、合并重复观察、模板与引用校验。真实 Miniflare/D1 API 测试覆盖密钥加密落盘、驱逐恢复、留空保留/替换/清除、地址绑定、鉴权、未配置跳过、局部设置、并发租约、幂等、晚到输入、模型失败、D1 失败复用结果和分页。浏览器测试覆盖密钥表单、设置持久化、手机布局、小时报告展开和稳定刷新。
