import { z } from "zod";
import { type WatchPortSchema, WatchPortsSchema } from "./schema.ts";

export const MachineInput = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().trim().min(1).max(120),
  watchPorts: WatchPortsSchema.default([]),
});
export const MachineName = MachineInput.pick({ name: true });
export type Registration = {
  id: string;
  name: string;
  enabled: boolean;
  source: "legacy" | "managed";
  credentialId: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
  expiresAt: string | null;
  watchPorts: z.infer<typeof WatchPortSchema>[];
};
export type IssuedCredential = { machine: Registration; token: string };

export function onboardingPrompt(
  machine: Registration,
  token: string,
  url: string,
  watchPorts: z.infer<typeof WatchPortSchema>[],
  publishedAgentVersion: string,
) {
  const config = {
    url,
    machineId: machine.id,
    machineName: machine.name,
    token,
    intervalSeconds: 30,
    watchPorts,
  };
  return `请把这台机器接入 Eagle，并验证完整上报。\n\n1. 下载并安装 Agent（macOS / Linux）：\n   先执行 node --version、npm --version、herdr --version，确认 Node.js 24+、npm 和 Herdr CLI 可用。缺少 Node.js 时从 https://nodejs.org/en/download 安装 24+；Herdr 须已安装并运行。Agent 无须克隆 Eagle 仓库。\n   从 npm 安装固定版本 Agent v${publishedAgentVersion}（网站可独立更新）：\n   npm install -g @nocoo/eagle-agent@${publishedAgentVersion} --registry=https://registry.npmjs.org\n   如果 npm 下载失败或超时，首选腾讯云镜像：\n   npm install -g @nocoo/eagle-agent@${publishedAgentVersion} --registry=https://mirrors.cloud.tencent.com/npm/\n   上述 --registry 只作用于本次安装，不修改全局 npm 配置。镜像可能延迟同步；如返回 404 / ETARGET，稍后重试或在网络恢复后改用官方源，不要擅自安装旧版本。公开包下载无须 npm 登录，也不要把 Eagle Token 交给 npm 或镜像。保留 HTTPS 和证书校验。\n   安装后执行 eagle-agent --version（应输出 ${publishedAgentVersion}）、eagle-agent --help；找不到命令时检查 npm 全局 bin 是否在 PATH 中。\n2. 先定位实际使用的配置：检查已有服务的 EAGLE_CONFIG；未指定时才使用 ~/.config/eagle/agent.json。只核对 machineId 和 url，不打印 token。确认下方 url 是用户认可的目标上报地址；用 URL 解析比较 origin（协议、主机、端口），不能只比较 hostname。\n   - 新接入：通过 stdin 传给 eagle-agent init 创建安全配置（目录 0700、文件 0600）；init 拒绝覆盖已有文件。自定义配置目录必须显式设置 spoolDir 为该目录下独立的 spool 子目录，使 latest-report.json 也与该环境隔离。\n   - 同环境轮换：仅当机器 ID 和规范化后的 origin 都相同，才在安全备份后只替换 token，保留 watchPorts、codexDir、spoolDir、intervalSeconds。更新后重启使用该配置且已启用的 watch、realtime-watch 服务，并核对新回执和页面更新时间；不要因此启动尚未启用的可选服务。ID 不一致时停止并询问用户，不能把旧机器改成新身份。\n   - 跨环境迁移：即使 ID 相同，只要 origin 不同就不是凭据轮换。先确认迁移目标；不得把新 token 写入旧地址的配置，也不能仅改旧配置的 url 后直接运行 once。创建独立的 0700 配置目录和 0600 配置文件，使用下方目标 url/凭据，并显式设置 spoolDir 为新目录下的空 spool。不得复制旧 spool、latest-report.json；历史迁移须另行获得用户授权。\n   - 后续所有 init、once、watch、realtime-watch 都使用选定配置的绝对 EAGLE_CONFIG 路径，并在 launchd/systemd 的环境中显式设置 EAGLE_CONFIG；不要让命令默默退回旧的默认配置。\n   - 新环境首次上报和页面核对成功后，才停止已确认的旧采集服务并切换持续上报；按用户明确选择处理旧实时服务，不自动启动可选服务，不重复启动相同配置的进程。保留原环境用于回滚：不覆盖旧配置，不删除旧队列；不得在未停用新服务时盲目启动第二个采集器。\n3. Token 只写入安全配置，不打印、不放在命令参数、Git、日志或上报数据中。\n4. 执行 eagle-agent once，确认回执成功，核对全部 Herdr sessions、Spaces、Panes 以及机器资源。随后配置当前用户的 launchd（macOS）或 systemd（Linux）服务运行 eagle-agent watch；使用可执行文件绝对路径，确保服务能找到 node 和 herdr。防止同一配置启动多个采集器。\n   网络默认直连：服务设置 NODE_USE_ENV_PROXY=0，不写入代理地址。代理是可选项；仅在用户明确需要代理时，使用用户提供并验证可达的 HTTP(S) 代理地址设置 HTTPS_PROXY 和 NODE_USE_ENV_PROXY=1，不猜测主机或端口。HTTP 目标使用 HTTP_PROXY；按需设置 NO_PROXY。代理设置写入服务环境，不写入上报数据。watch、realtime-watch 均按该机器的网络选择配置；实时代理需要 Node.js 24.5+。切回直连时移除服务中的代理地址并设置 NODE_USE_ENV_PROXY=0；重新加载服务配置后核对成功上报及积压清空，不能仅凭进程运行判断恢复。\n5. 如需网页实时控制，另建当前用户服务运行 eagle-agent realtime-watch，沿用同一安全配置，防止重复启动。这会允许通过 Eagle 中的“实时模式”查看终端并接管输入；退出/切换/页面后台自动回收订阅，断线输入不重放。详情 https://github.com/nocoo/eagle/blob/main/docs/REALTIME.md 。\n6. 在 Eagle 中核对机器 ${machine.id} 的最新采集时间与全部 Space。TCP 端口监听仅是连通证据，不代表任务已完成。保持终端总结、Goal、Git、测试、进程和线上证据的原始时间与 revision。\n\n安全配置：\n${JSON.stringify(config, null, 2)}\n\n确定性快照、资源样本和日报输入持久化在机器 DO；心跳与回执不写历史。\n${url.includes(".dev.") ? "这是本地开发环境；仅在可访问本地 Caddy 域名且信任其证书的机器上使用。" : ""}`;
}
