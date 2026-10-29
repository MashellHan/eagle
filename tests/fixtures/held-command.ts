import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function heldCommand(work: string) {
  const tag = `eagle-held-${randomUUID()}`;
  const expiresAt = Date.now() + 10_000;
  writeFileSync(
    join(work, "command-intent.json"),
    JSON.stringify({ tag, expiresAt }),
    { mode: 0o600 },
  );
  return {
    tool: "command.exec" as const,
    program: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs');const tag=${JSON.stringify(tag)};const expiry=setTimeout(()=>process.exit(1),Math.max(0,${expiresAt}-Date.now()));fs.writeFileSync('command-process.json',JSON.stringify({pid:process.pid,tag}),{mode:0o600});fs.appendFileSync('attempts','once\\n');const tick=setInterval(()=>{if(fs.existsSync('release')){clearTimeout(expiry);clearInterval(tick);process.stdout.write(process.cwd());}},10)`,
    ],
    cwd: work,
    timeoutMs: 10_000,
  };
}

export async function stopHeldCommand(work: string): Promise<boolean> {
  if (!existsSync(join(work, "command-intent.json"))) return true;
  if (!existsSync(join(work, "command-process.json"))) return false;
  try {
    const intent = JSON.parse(
      readFileSync(join(work, "command-intent.json"), "utf8"),
    );
    const { pid, tag } = JSON.parse(
      readFileSync(join(work, "command-process.json"), "utf8"),
    );
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      tag !== intent.tag ||
      typeof tag !== "string" ||
      !/^eagle-held-[a-f0-9-]{36}$/.test(tag)
    )
      return false;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    if (!alive()) return true;
    // A retained PID alone is never authority to kill. The current argv must
    // carry this private fixture's random identity and the expected Node path.
    const current = spawnSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "command="],
      { encoding: "utf8", timeout: 2000 },
    );
    if (!alive()) return true;
    if (
      current.status !== 0 ||
      !current.stdout.startsWith(`${process.execPath} `) ||
      !current.stdout.includes(JSON.stringify(tag))
    )
      return false;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 2000;
    while (alive() && Date.now() < deadline) await delay(10);
    return !alive();
  } catch {
    return false;
  }
}
