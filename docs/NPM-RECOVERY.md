# Recover exact npm dependencies

Use this runbook when an install fails on a locked package, registry metadata,
transport, or an offline-cache miss. Recover the versions and original bytes in
the current locks; this is not a dependency-upgrade procedure. Follow the current
user authorization and machine registry policy, including any source exception
already granted for this task. Do not ask again for a covered action or convert
a one-task exception into permanent configuration.

## Recovery sequence

1. Establish one dependency writer and preserve Git status, staged changes and
   any observed dependency tree still needed as evidence. Record Node/npm and
   OS/architecture, both lock SHA256 values, and the actual failed command/error.
   Eagle has two installation roots: the repository and independent `apps/bots`.
   Root `npm ci` does not install the Bots product.
2. Inspect only relevant registry/cache/proxy/CA settings, without dumping auth
   configuration or the whole environment. Distinguish HTTP `E404`/`ETARGET`
   from connection/TLS failure and `ENOTCACHED`. Make bounded requests for the
   exact missing version; stop retrying the same failure without new evidence.
   Metadata and tarball availability are separate facts.
3. Inventory all required lock entries and the installed/platform-relevant
   optional packages. Look up existing cached bytes by lock integrity. For
   missing artifacts, fetch the original exact-version `.tgz` from a currently
   authorized HTTPS source into a private task directory. Keep TLS verification
   enabled; do not change DNS/SSL policy, reconstruct a tarball from Git or use
   a nearby installed version. The first reported missing package is not the
   full inventory.
4. Verify each original tarball against the trusted lock SRI and its embedded
   package name/version before adding it to a new private npm cache. Record the
   lock entry, URL, file, hash and result. Inspect tar members without extracting
   arbitrary paths or running package scripts. Most packages use
   `package/package.json`; `@types/ws` in this incident used `ws/package.json`.
   A mirror's own checksum alone is not sufficient.
5. Populate the private cache with normal `npm cache add` commands, then run
   normal `npm ci` separately at both roots. Do not hand-edit cache indexes or
   metadata, omit lifecycle scripts to evade `prepare`, change lock versions,
   borrow Bots' Biome for root hooks, or bypass a failed check. Keep the previous
   observed installation separately when needed; `npm ci` replaces its target
   `node_modules`.
6. Recheck both lock hashes, staged/user changes and installed versions. Carry the
   same task cache and logical registry into pack/install checks, App assembly
   and ordinary Git hooks. Run the required gates; an install or compile alone
   does not establish release readiness. Reuse a completed check only when its
   applicable inputs remain unchanged.

For this repository's SHA512 lock entries, this read-only example verifies bytes
and package identity without extracting or executing the archive. Supply the
actual lock, its exact `packages` key and the downloaded file:

```sh
python3 - package-lock.json node_modules/ws /absolute/path/to/ws-8.22.0.tgz <<'PY'
import base64, hashlib, json, sys, tarfile
from pathlib import Path, PurePosixPath

lock_path, package_path, archive_path = sys.argv[1:]
entry = json.loads(Path(lock_path).read_text())["packages"][package_path]
actual = "sha512-" + base64.b64encode(
    hashlib.sha512(Path(archive_path).read_bytes()).digest()
).decode()
if actual != entry["integrity"]:
    raise ValueError("lock SRI mismatch")
with tarfile.open(archive_path, "r:gz") as archive:
    manifests = [m for m in archive.getmembers() if m.isfile()
                 and PurePosixPath(m.name).name == "package.json"
                 and len(PurePosixPath(m.name).parts) == 2]
    if len(manifests) != 1 or manifests[0].size > 1024 * 1024:
        raise ValueError("ambiguous or oversized package manifest")
    package = json.load(archive.extractfile(manifests[0]))
if package["name"] != package_path.rsplit("node_modules/", 1)[-1]:
    raise ValueError("package name mismatch")
if package["version"] != entry["version"]:
    raise ValueError("package version mismatch")
print(json.dumps({"name": package["name"], "version": package["version"],
                  "integrity": actual}))
PY
```

After verification, use `npm cache add /absolute/verified/package.tgz
--cache=/absolute/task/cache`. Use a new owned task cache, not a global cache
mutation; retain the artifact manifest alongside it.

## A successful offline ci can still lack pack metadata

Content-addressed tarballs do not satisfy every registry-specific packument
request. A fresh prefix or npm-generated wrapper lock can need metadata even
after both locked installs have succeeded. When the error names metadata, cache
the actual exact package under the authorized logical registry, for example:

```sh
npm cache add ws@8.22.0 --cache=/absolute/task/cache \
  --registry=https://repo.huaweicloud.com/repository/npm/ \
  --fetch-retries=0 --fetch-timeout=20000
npm view ws@8.22.0 name version dist.integrity --json --offline \
  --cache=/absolute/task/cache \
  --registry=https://repo.huaweicloud.com/repository/npm/
```

The mirror/version above are this incident's authorized example, not a default
for another task. Verify the returned identity and SRI against that task's lock.
The same steps were needed for `zod@4.6.7`. Do not fabricate a packument or let a
new prefix silently choose a newer semver match. Eagle's Agent bundle now uses
an npm-generated private wrapper lock, exact overrides from root lock, every-node
version/SRI checks and local-tarball SHA512, then normal offline ci and installed
dependency-resolution checks.

## Verified 2026-10-29 incident

The approved proxy lacked locked artifacts including root Biome 2.6.3, Wrangler
4.152.0 and Anthropic 4.0.88; the independent Bots lock also required Smithy core
3.36.2. An authorized official-registry attempt failed at the connection/TLS
layer (`ENOTCONN`/timeout). It did not reach a useful HTTP/package response.
The observed installation had 20 version differences and was not fresh-lock
release evidence. Root and Bots retain their own Biome versions, 2.6.3 and 2.6.2.

After the user authorized alternate original-artifact transport for this task,
43 missing tarballs were retrieved from `repo.huaweicloud.com`. All 43 matched
their lock SHA512 and package identity. Together with 264 previously inventoried
verified cache blobs, normal `npm cache add` populated a private cache with 307
distinct artifacts. No tarball was rebuilt, and no SSL or global registry setting
was changed. The retained local cache is:

```text
/Users/mengxionghan/workspace/eagle/.local/exact-artifacts-20261029-m34sr1ym/npm-cache
```

This is an incident artifact, not a portable path or proof for future locks.
Using npm 11.19.1, the initial successful installs used the **official logical
registry with offline fetching**. That success is not evidence that the official
network endpoint had recovered:

```sh
# At the repository root, with the verified task cache substituted below:
npm ci --offline --cache /absolute/task/cache \
  --registry=https://registry.npmjs.org/ --no-audit --no-fund

# Separately in apps/bots:
npm ci --offline --cache /absolute/task/cache \
  --registry=https://registry.npmjs.org/ \
  --replace-registry-host=https://mirrors.tencent.com/npm/ --no-audit --no-fund
```

The Bots command replaced the lock's whole old registry prefix in npm's request
routing; it did not rewrite the lock. Inspect `resolved` URLs and the installed
npm's behavior before copying this option: host-only/`always` replacement can
retain an unwanted `/npm/` path. Both installs returned 0. The version audit
matched 213 installed root packages and 101 Bots packages with no required
mismatch. Root's absent `@emnapi/runtime` and `@img/sharp-wasm32` were documented
optional omissions, not skipped required dependencies.

Both lock SHA256 values, the staged patch and default registry remained unchanged:

| Lock | SHA256 before and after |
| --- | --- |
| `package-lock.json` | `a2ab0b2649a6bc598c2625192afa37c6b10d841fa1cfe03bf95c89e51cb5558a` |
| `apps/bots/package-lock.json` | `177687adf5cff461cb0513dcbb2a32c0f8dea26ce1328ba6b2a146979f17018f` |

Later Agent pack/install checks failed on missing `ws` metadata. Normal npm
commands cached real `ws@8.22.0` and `zod@4.6.7` packuments under the Huawei URL
and verified their identity/SRI offline. Subsequent gates, nested bundle installs,
App assembly and normal hooks inherited this **different logical registry**:

```text
npm_config_cache=/absolute/task/cache
npm_config_registry=https://repo.huaweicloud.com/repository/npm/
npm_config_offline=true
```

These were process-scoped settings under this task's authorization. They are not
a permanent source change. `--offline` applies to npm fetching; lifecycle scripts,
Playwright browser installation and Xcode setup are separate operations.
`--no-audit` skips npm's installation-time network audit, not a separately required
security/release check. Normal installs ran their lifecycle scripts and hooks.

## Scheduler boundary and retained evidence

The installed upstream-sync job still used its original approved proxy. Its
08:08 merge attempt failed with Wrangler 4.152.0 `E404` and did not push. Its
child environment allowlist did not carry the interactive cache/offline settings;
adding an unused JSON key or exporting a shell variable would not repair it.
This recovery did not change its config, registry, launcher, cadence or authorization.
Do not claim the job is fixed because a foreground task succeeds, or reuse an old
cache as proof that a changed future upstream lock is installable. Any authorized
repair must verify the actual child environment and retain normal gates and the
[shared scheduler lock](UPSTREAM-SYNC.md).

The portable findings are this runbook and [the retrospective](../Retrospective.md).
Original local receipts remain available on the recovery machine:

| Receipt | What it proves |
| --- | --- |
| `.local/dependency-recovery-official-20261028.json` | Authorized official attempt and bounded transport failure |
| `.local/exact-artifacts-latest-20261029.json` | 43/43 original downloads and their SRI/identity manifest |
| `.local/exact-npm-cache-20261029.json` | 307 verified artifacts and normal cache-add exit/log/hash |
| `.local/exact-install-20261029.json` | Exact ci commands, exits, lock/stage/default-registry hashes and version audit |
| `.local/exact-packuments-cache-20261029.json` | Real registry-specific metadata and offline identity/SRI checks |
| `.local/delivery-final-gates.json` | Subsequent actual gates, source hashes and log provenance |

These ignored paths may not exist on another Mac. Inventory the current locks and
authorization there; do not substitute old counts, versions or temporary paths
for fresh evidence. Preserve unrelated user changes and all earlier failure logs.
