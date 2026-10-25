// Workspace confinement (docs/bots/RUNTIME.md, "Tools"): every path a tool touches is
// resolved inside the bot's workspace, lexically and through symlinks, so an
// auto-executed tool cannot read or write the rest of the machine.
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { MAX_PATH_CHARS } from "./limits.ts";
import { ToolError } from "./types.ts";

export const ensureWorkspace = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
};

/** The root every tool resolves against: its real path, so comparisons never cross a link. */
export const canonicalWorkspace = (root: string): Promise<string> => realpath(root);

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

/** The real path of the target, or of its deepest existing ancestor for a new file. */
const realLocation = async (path: string): Promise<string> => {
  let current = path;
  for (;;) {
    const real = await realpath(current).catch(() => undefined);
    if (real !== undefined) return real;
    const parent = resolve(current, "..");
    if (parent === current) throw new ToolError("the path cannot be resolved");
    current = parent;
  }
};

/**
 * Resolves `path` inside the workspace. Absolute paths are accepted only when they land
 * inside it; `..` and a symlink that leaves it are refused.
 */
export const resolveInside = async (root: string, path: string): Promise<string> => {
  if (path.length === 0) throw new ToolError("a path is required");
  if (path.length > MAX_PATH_CHARS) throw new ToolError("the path is too long");
  if (path.includes("\0")) throw new ToolError("the path contains a null byte");
  const canonicalRoot = await realpath(root);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(canonicalRoot, path);
  if (!isInside(canonicalRoot, candidate)) {
    throw new ToolError(`the path is outside the workspace: ${path}`);
  }
  const real = await realLocation(candidate);
  if (!isInside(canonicalRoot, real)) {
    throw new ToolError(`the path leaves the workspace through a link: ${path}`);
  }
  return candidate;
};

/** The workspace-relative form of a path, for display and for the model. */
export const relativeTo = (root: string, path: string): string => {
  const prefix = `${root}${sep}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};
