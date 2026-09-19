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
) {
  const config = {
    url,
    machineId: machine.id,
    machineName: machine.name,
    token,
    intervalSeconds: 30,
    watchPorts,
  };
  return `请把这台机器接入 Eagle，并验证完整上报。\n\n1. 下载并安装 Agent（macOS / Linux）：\n   先执行 node --version、npm --version、herdr --version，确认 Node.js 24+、npm 和 Herdr CLI 可用。缺少 Node.js 时从 https://nodejs.org/en/download 安装 24+；Herdr 须已安装并运行。Agent 无须克隆 Eagle 仓库。\n   使用 npm 官方源下载并全局安装固定版本：\n   npm install -g @nocoo/eagle-agent@0.3.0 --registry=https://registry.npmjs.org\n   如果 npm 官方源连接失败或超时，首选腾讯云镜像：\n   npm install -g @nocoo/eagle-agent@0.3.0 --registry=https://mirrors.cloud.tencent.com/npm/\n   上述 --registry 只作用于本次安装，不修改全局 npm 配置。镜像可能延迟同步；如返回 404 / ETARGET，稍后重试或在网络恢复后改用官方源，不要擅自安装旧版本。公开包下载无须 npm 登录，也不要把 Eagle Token 交给 npm 或镜像。保留 HTTPS 和证书校验。\n   安装后执行 eagle-agent --version（应输出 0.3.0）、eagle-agent --help；找不到命令时检查 npm 全局 bin 是否在 PATH 中。\n2. 先检查 ~/.config/eagle/agent.json 是否存在。不存在：通过文件工具写入下方 JSON（目录 0700、文件 0600），或将 JSON 通过标准输入传给 eagle-agent init。已存在：先读取并核对 machineId；只有与下方 ID 一致时，才只替换 token，并保留 evidenceFile、watchPorts、codexDir、spoolDir、intervalSeconds 等所有现有设置。不要对已有配置执行 init，也不要用下方 JSON 整体覆盖它；ID 不一致时停止并询问用户。更新后重启已有采集服务。\n3. Token 只写入安全配置，不打印、不放在命令参数、Git、日志或上报数据中。\n4. 执行 eagle-agent once，确认回执成功，核对全部 Herdr sessions、Spaces、Panes 以及机器资源。随后配置当前用户的 launchd（macOS）或 systemd（Linux）服务运行 eagle-agent watch；使用可执行文件绝对路径，确保服务能找到 node 和 herdr。防止同一配置启动多个采集器。\n5. 在 Eagle 中核对机器 ${machine.id} 的最新采集时间与全部 Space。TCP 端口监听仅是连通证据，不代表任务已完成。保持终端总结、Goal、Git、测试、进程和线上证据的原始时间与 revision。\n\n安全配置：\n${JSON.stringify(config, null, 2)}\n\n当前上报维护机器的 Durable Object；小时总结和新的 D1 历史写入暂未启用。\n${url.includes(".dev.") ? "这是本地开发环境；仅在可访问本地 Caddy 域名且信任其证书的机器上使用。" : ""}`;
}
