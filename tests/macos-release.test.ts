// A website release may ship no macOS app at all, so `/api/live` may only claim an app version
// that is actually attached to a GitHub release -- never the app's source version.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import manifest from "../package.json" with { type: "json" };

const parts = (version: string) =>
  (version.split("-")[0] ?? "").split(".").map((part) => Number(part));

const isNewer = (candidate: string, than: string): boolean => {
  const left = parts(candidate);
  const right = parts(than);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0;
    const two = right[index] ?? 0;
    if (one !== two) return one > two;
  }
  return false;
};

test("the live app version is the manifest's claim, not the app's source version", () => {
  const deploy = readFileSync("scripts/deploy.ts", "utf8");
  assert.match(deploy, /config\?\.publishedMacosVersion/);
  assert.doesNotMatch(
    deploy,
    /Support\/Version\.json/,
    "deploy must not publish the app's source version",
  );
  const example = readFileSync("apps/web/wrangler.example.jsonc", "utf8");
  assert.doesNotMatch(
    example,
    /MACOS_VERSION|MACOS_RELEASE_URL/,
    "the deployment config must not carry a second app version",
  );
});

test("a declared app version never runs ahead of the app source", () => {
  const config = (manifest as { config?: { publishedMacosVersion?: string } })
    .config;
  const source = (
    JSON.parse(readFileSync("apps/macos/Support/Version.json", "utf8")) as {
      version: string;
    }
  ).version;
  const published = config?.publishedMacosVersion;
  if (published === undefined) return;
  assert.match(
    published,
    /^\d+\.\d+\.\d+$/,
    "a published version is a plain release number",
  );
  assert.ok(
    !isNewer(published, source),
    `published ${published} must not exceed the source ${source}`,
  );
});
