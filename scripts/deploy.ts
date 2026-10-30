import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw new Error(
    "Commit the release before deploying; the health endpoint must identify the exact source revision.",
  );
const revision = git("rev-parse", "HEAD");
// The tracked repository carries only an example. A deployment names its own configuration:
// the local file when one exists, otherwise the JSON in EAGLE_WRANGLER_CONFIG (CI secret).
const configPath = "apps/web/wrangler.jsonc";
const inline = process.env.EAGLE_WRANGLER_CONFIG?.trim();
if (!existsSync(configPath)) {
  if (inline === undefined || inline === "") {
    throw new Error(
      "no deployment configuration: create apps/web/wrangler.jsonc from its example, or set EAGLE_WRANGLER_CONFIG",
    );
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${inline}\n`, { mode: 0o600 });
}
execFileSync("npm", ["--workspace", "@eagle/web", "run", "build"], {
  stdio: "inherit",
});
execFileSync(
  "node_modules/.bin/wrangler",
  ["deploy", "--config", configPath, "--var", `BUILD_REVISION:${revision}`],
  { stdio: "inherit" },
);
