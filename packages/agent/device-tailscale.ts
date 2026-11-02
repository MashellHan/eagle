import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

export const isTailnetAddress = (address: string): boolean => {
  if (isIP(address) === 6) return /^fd7a:115c:a1e0:/i.test(address);
  const octets = address.split(".").map(Number);
  const second = octets[1] ?? -1;
  return (
    isIP(address) === 4 && octets[0] === 100 && second >= 64 && second < 128
  );
};

export async function readTailscaleAddress(
  run = async (file: string, args: string[]) =>
    (
      await promisify(execFile)(file, args, {
        timeout: 1000,
        maxBuffer: 256 * 1024,
      })
    ).stdout,
): Promise<string | undefined> {
  for (const file of [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ]) {
    try {
      const status = JSON.parse(await run(file, ["status", "--json"]));
      if (
        status.BackendState !== "Running" ||
        !Array.isArray(status.Self?.TailscaleIPs)
      )
        return;
      return status.Self.TailscaleIPs.find(
        (ip: unknown) => typeof ip === "string" && isTailnetAddress(ip),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  }
}
