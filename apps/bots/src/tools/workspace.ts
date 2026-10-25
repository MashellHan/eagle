// Workspace confinement (docs/bots/RUNTIME.md, "Tools"): every path a tool touches is
// resolved inside the bot's workspace, and a symlink is refused anywhere below it, so an
// auto-executed tool cannot reach the daemon's root or another bot through the file
// system. The workspace is refused if it is itself a link.
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_PATH_CHARS } from "./limits.ts";
import { ToolError } from "./types.ts";

/** Creates the workspace and refuses a pre-existing symlink or non-directory. */
export const ensureWorkspace = async (root: string): Promise<void> => {
  const existing = await lstat(root).catch(() => undefined);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) throw new ToolError(`the workspace is a link: ${root}`);
    if (!existing.isDirectory()) throw new ToolError(`the workspace is not a directory: ${root}`);
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
};

/** The root every tool resolves against: its real path, so paths above it may be links. */
export const canonicalWorkspace = (root: string): Promise<string> => realpath(root);

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

/** Rejects a symlink at or below the workspace root, including a dangling one. */
const assertNoLinks = async (root: string, path: string): Promise<void> => {
  const rest = relative(root, path);
  if (rest.length === 0) return;
  let current = root;
  for (const part of rest.split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined) return; // the rest does not exist yet
    if (info.isSymbolicLink()) {
      throw new ToolError(`the path leaves the workspace through a link: ${path}`);
    }
  }
};

/**
 * Resolves `path` inside the canonical workspace. Absolute paths are accepted only when
 * they land inside it; `..`, a symlink and a non-directory component are refused. The
 * caller still opens the final component with `O_NOFOLLOW`, so a link swapped in after
 * this check is not followed.
 */
export const resolveInside = async (root: string, path: string): Promise<string> => {
  if (path.length === 0) throw new ToolError("a path is required");
  if (path.length > MAX_PATH_CHARS) throw new ToolError("the path is too long");
  if (path.includes("\0")) throw new ToolError("the path contains a null byte");
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!isInside(root, candidate)) {
    throw new ToolError(`the path is outside the workspace: ${path}`);
  }
  await assertNoLinks(root, candidate);
  return candidate;
};

/** The workspace-relative form of a path, for display and for the model. */
export const relativeTo = (root: string, path: string): string => {
  const prefix = `${root}${sep}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};
