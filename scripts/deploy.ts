import { execFileSync } from "node:child_process";

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw new Error(
    "Commit the release before deploying; the health endpoint must identify the exact source revision.",
  );
const revision = git("rev-parse", "HEAD");
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
execFileSync(
  "node_modules/.bin/wrangler",
  ["deploy", "--var", `BUILD_REVISION:${revision}`],
  { stdio: "inherit" },
);
