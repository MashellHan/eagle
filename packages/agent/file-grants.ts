import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { redact, stripRetiredConfig } from "./collector.ts";
import { ConfigSchema } from "./config.ts";
import { type FileGrant, fileRootFingerprint } from "./file-provider.ts";
import {
  privateDirectory,
  privateFile,
  servicePaths,
  withConfigurationControl,
} from "./service.ts";

export type LocalFileGrant = FileGrant & {
  name: string;
  rootFingerprint: string;
};
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const grantSchema = z.strictObject({
  id: idSchema,
  generation: z.string().uuid(),
  root: z.string().max(4096),
  rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(120),
});
const storeSchema = z.strictObject({
  version: z.literal(1),
  grants: z.array(grantSchema).max(32),
});
/** This authority is local to the machine; remote operations cannot grant roots. */
export class FileGrants {
  private config: string;
  private directory: string;
  private path: string;
  constructor(configPath: string) {
    const paths = servicePaths(configPath);
    this.config = paths.config;
    this.directory = paths.directory;
    this.path = join(paths.directory, "file-grants.json");
  }
  list(): LocalFileGrant[] {
    privateDirectory(this.directory);
    if (!lstatSync(this.path, { throwIfNoEntry: false })) return [];
    const value = storeSchema.parse(
      JSON.parse(privateFile(this.path).toString()),
    );
    if (
      new Set(value.grants.map((grant) => grant.id)).size !==
        value.grants.length ||
      new Set(value.grants.map((grant) => grant.root)).size !==
        value.grants.length
    )
      throw new Error("Invalid file grant authority");
    return value.grants;
  }
  grant(input: unknown): LocalFileGrant {
    const request = z
      .strictObject({
        root: z.string().min(1).max(4096),
        name: z.string().trim().min(1).max(120),
      })
      .parse(input);
    return withConfigurationControl(this.config, () => {
      if (!isAbsolute(request.root))
        throw new Error("Choose an absolute directory");
      const config = ConfigSchema.parse(
        stripRetiredConfig(JSON.parse(privateFile(this.config).toString()))
          .value,
      );
      if (
        [request.root, request.name].some(
          (text) => redact(text, [config.token]) !== text,
        )
      )
        throw new Error("Credential cannot be granted");
      const root = realpathSync(request.root);
      if (
        root === this.directory ||
        root.startsWith(this.directory + sep) ||
        [root, request.name].some(
          (text) => redact(text, [config.token]) !== text,
        )
      )
        throw new Error("Private directory or credential cannot be granted");
      const fingerprint = fileRootFingerprint(root);
      const grants = this.list();
      const existing = grants.find((grant) => grant.root === root);
      if (existing?.rootFingerprint === fingerprint) return existing;
      const grant = {
        id: `fg_${randomUUID()}`,
        generation: randomUUID(),
        root,
        name: request.name,
        rootFingerprint: fingerprint,
      };
      this.write([...grants.filter((entry) => entry.root !== root), grant]);
      return grant;
    });
  }
  revoke(id: string): void {
    idSchema.parse(id);
    withConfigurationControl(this.config, () => {
      const grants = this.list();
      if (grants.some((grant) => grant.id === id))
        this.write(grants.filter((grant) => grant.id !== id));
    });
  }
  private write(grants: LocalFileGrant[]) {
    const contents = JSON.stringify(storeSchema.parse({ version: 1, grants }));
    if (Buffer.byteLength(contents) > 65_536)
      throw new Error("File grant configuration limit exceeded");
    const temporary = join(this.directory, `.file-grants-${randomUUID()}.tmp`);
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, contents);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (lstatSync(this.path, { throwIfNoEntry: false }))
        privateFile(this.path);
      renameSync(temporary, this.path);
      const directory = openSync(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
