// The file tools (docs/bots/RUNTIME.md, "Tools"): read, write and list inside the bot's
// workspace. They return results rather than throwing, so a refusal reaches the model as
// text it can act on. Files are opened with O_NOFOLLOW and only regular files are read, so
// a FIFO, a device or a link cannot stall or redirect a call.
import type { Dirent } from "node:fs";
import { constants, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { MAX_LIST_ENTRIES, MAX_READ_BYTES, MAX_READ_LINES, MAX_WRITE_BYTES } from "./limits.ts";
import { type BotWorkspace, failed, ToolError, type ToolOutcome } from "./types.ts";
import { canonicalWorkspace, relativeTo, resolveInside } from "./workspace.ts";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "dist", ".build"]);

export type ReadFileArgs = {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
};

/** A text page of one file: lines `offset`..`offset+limit-1`, with a visible truncation note. */
export const readFileTool = async (
  workspace: BotWorkspace,
  args: ReadFileArgs,
): Promise<ToolOutcome> => {
  try {
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
      return failed("limit must be a positive integer");
    }
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 1)) {
      return failed("offset must be a positive integer");
    }
    const root = await canonicalWorkspace(workspace.root);
    const path = await resolveInside(root, args.path);
    // O_NOFOLLOW keeps a link swapped in after resolution from being followed.
    // O_NONBLOCK so a FIFO or device cannot stall the open; the type is checked on the
    // handle, which is the object the read then uses.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing" as const;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return "link" as const;
      return "unreadable" as const;
    });
    if (handle === "missing") return failed(`no such file: ${args.path}`);
    if (handle === "link") return failed(`the path is a link: ${args.path}`);
    if (handle === "unreadable") return failed(`the file could not be opened: ${args.path}`);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return failed(`${args.path} is not a regular file`);
      if (info.size > MAX_READ_BYTES * 8) {
        return failed(`the file is too large to read (${info.size} bytes)`);
      }
      const bytes = await handle.readFile();
      if (bytes.includes(0)) return failed(`${args.path} is not a text file`);
      const text = bytes.toString("utf8");
      const lines = text.split("\n");
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();
      const offset = args.offset ?? 1;
      const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
      const page = lines.slice(offset - 1, offset - 1 + limit);
      if (page.length === 0) return { output: `(no lines at offset ${offset})` };
      let body = page.join("\n");
      if (Buffer.byteLength(body) > MAX_READ_BYTES) {
        body = Buffer.from(body).subarray(0, MAX_READ_BYTES).toString("utf8");
        return { output: `${body}\n[truncated: the page exceeds ${MAX_READ_BYTES} bytes]` };
      }
      if (offset - 1 + page.length < lines.length || offset > 1) {
        return {
          output: `${body}\n[lines ${offset}-${offset + page.length - 1} of ${lines.length}]`,
        };
      }
      return { output: body };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failed(error instanceof ToolError ? error.message : "the file could not be read");
  }
};

export type WriteFileArgs = {
  readonly path: string;
  readonly content: string;
};

/** Writes one file, creating its parent directories inside the workspace. */
export const writeFileTool = async (
  workspace: BotWorkspace,
  args: WriteFileArgs,
): Promise<ToolOutcome> => {
  try {
    const bytes = Buffer.byteLength(args.content);
    if (bytes > MAX_WRITE_BYTES) return failed(`the content exceeds ${MAX_WRITE_BYTES} bytes`);
    const root = await canonicalWorkspace(workspace.root);
    const path = await resolveInside(root, args.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return "link" as const;
      return "unwritable" as const;
    });
    if (handle === "link") return failed(`the path is a link: ${args.path}`);
    if (handle === "unwritable") return failed(`the file could not be written: ${args.path}`);
    try {
      // `mode` at open only applies to a new file: an overwrite is tightened explicitly.
      await handle.chmod(0o600);
      await handle.writeFile(args.content);
    } finally {
      await handle.close();
    }
    return { output: `wrote ${bytes} bytes to ${relativeTo(root, path)}` };
  } catch (error) {
    return failed(error instanceof ToolError ? error.message : "the file could not be written");
  }
};

export type ListFilesArgs = {
  readonly path?: string;
  readonly limit?: number;
};

/** A bounded, deterministic walk of the workspace; directories end with `/`. */
export const listFilesTool = async (
  workspace: BotWorkspace,
  args: ListFilesArgs,
): Promise<ToolOutcome> => {
  try {
    const limit = Math.min(args.limit ?? MAX_LIST_ENTRIES, MAX_LIST_ENTRIES);
    if (!Number.isInteger(limit) || limit < 1) return failed("limit must be a positive integer");
    const root = await canonicalWorkspace(workspace.root);
    const start = await resolveInside(root, args.path ?? ".");
    const startInfo = await lstat(start).catch(() => undefined);
    if (startInfo === undefined) return failed(`no such path: ${args.path ?? "."}`);
    if (startInfo.isSymbolicLink()) return failed(`the path is a link: ${args.path ?? "."}`);
    if (startInfo.isFile()) return { output: args.path ?? "." };
    if (!startInfo.isDirectory()) return failed(`${args.path ?? "."} is not a directory`);

    const found: string[] = [];
    let truncated = false;
    const walk = async (directory: string): Promise<void> => {
      if (found.length >= limit) {
        truncated = true;
        return;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        // A directory that cannot be listed is reported, never silently rendered empty.
        throw new ToolError(`the directory could not be listed: ${relativeTo(root, directory)}`);
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (found.length >= limit) {
          truncated = true;
          return;
        }
        // A link is shown so the model knows it is there, but never followed.
        const path = join(directory, entry.name);
        const shown = `${relative(root, path).split(sep).join("/")}${entry.isDirectory() ? "/" : ""}`;
        found.push(shown);
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !IGNORED_DIRECTORIES.has(entry.name)
        ) {
          await walk(path);
        }
      }
    };
    await walk(start);
    if (found.length === 0) return { output: "(the workspace is empty)" };
    const body = found.join("\n");
    return {
      output: truncated ? `${body}\n[truncated: showing the first ${limit} entries]` : body,
    };
  } catch (error) {
    return failed(error instanceof ToolError ? error.message : "the workspace could not be listed");
  }
};
