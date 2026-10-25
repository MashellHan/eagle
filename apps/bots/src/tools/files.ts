// The file tools (docs/bots/RUNTIME.md, "Tools"): read, write and list inside the bot's
// workspace. They return results rather than throwing, so a refusal reaches the model as
// text it can act on. Files are opened with O_NOFOLLOW and only regular files are read or
// written, so a FIFO, a device or a link cannot stall or redirect a call.
import type { Dirent } from "node:fs";
import { constants, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_LIST_BYTES,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  MAX_SCAN_BYTES,
  MAX_WRITE_BYTES,
} from "./limits.ts";
import { type BotWorkspace, failed, ToolError, type ToolOutcome } from "./types.ts";
import { assertNoLinks, assertWorkspaceIdentity, relativeTo, resolveInside } from "./workspace.ts";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "dist", ".build"]);

export type ReadFileArgs = {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
};

const openError = (path: string, error: unknown): ToolOutcome => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return failed(`no such file: ${path}`);
  if (code === "ELOOP") return failed(`the path is a link: ${path}`);
  if (code === "ENXIO") return failed(`${path} is not a regular file`);
  return failed(`the file could not be opened: ${path}`);
};

/** A text page of one file: lines `offset`..`offset+limit-1`, with a visible page note. */
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
    await assertWorkspaceIdentity(workspace);
    const path = await resolveInside(workspace.root, args.path);
    // O_NONBLOCK so a FIFO or device cannot stall the open; the type is checked on the
    // handle, which is the object the read then uses.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => openError(args.path, error));
    if (!("close" in handle)) return handle;
    try {
      const info = await handle.stat();
      if (!info.isFile()) return failed(`${args.path} is not a regular file`);

      // The page is streamed: a large file is never read whole, and only the requested
      // lines are kept. The scan stops at its own cap, so a huge file still answers.
      const offset = args.offset ?? 1;
      const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      let scanned = 0;
      let pending = "";
      let lineNumber = 0;
      let page = "";
      let pageLines = 0;
      let started = false;
      let more = false;
      let full = false;
      let binary = false;
      let firstChunk = true;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        scanned += bytesRead;
        position += bytesRead;
        const piece = buffer.subarray(0, bytesRead);
        if (firstChunk && piece.includes(0)) binary = true;
        firstChunk = false;
        const text = decoder.write(piece);
        let start = 0;
        for (;;) {
          const index = text.indexOf("\n", start);
          if (index === -1) {
            pending += text.slice(start);
            break;
          }
          const line = `${pending}${text.slice(start, index)}`;
          pending = "";
          start = index + 1;
          lineNumber += 1;
          if (lineNumber < offset) continue;
          if (full) continue; // the page is complete; only count the remaining lines
          if (pageLines >= limit) {
            full = true;
            continue;
          }
          const next = pageLines === 0 ? line : `${page}\n${line}`;
          if (Buffer.byteLength(next) > MAX_READ_BYTES) {
            full = true;
            continue;
          }
          page = next;
          pageLines += 1;
          started = true;
        }
        if (scanned >= MAX_SCAN_BYTES) {
          more = true;
          break;
        }
      }
      if (binary) return failed(`${args.path} is not a text file`);
      // The trailing unterminated line is a line of its own.
      if (!more && pending.length > 0) {
        lineNumber += 1;
        if (!full && lineNumber >= offset) {
          const next = pageLines === 0 ? pending : `${page}\n${pending}`;
          if (Buffer.byteLength(next) <= MAX_READ_BYTES) {
            page = next;
            pageLines += 1;
            started = true;
          } else {
            full = true;
          }
        }
      }
      if (!started) return { output: `(no lines at offset ${offset})` };
      if (more) {
        return {
          output: `${page}\n[showing lines ${offset}-${offset + pageLines - 1}; the file continues]`,
        };
      }
      if (full || offset > 1) {
        return { output: `${page}\n[lines ${offset}-${offset + pageLines - 1} of ${lineNumber}]` };
      }
      return { output: page };
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

/** Writes one regular file, creating its parent directories inside the workspace. */
export const writeFileTool = async (
  workspace: BotWorkspace,
  args: WriteFileArgs,
): Promise<ToolOutcome> => {
  try {
    const bytes = Buffer.byteLength(args.content);
    if (bytes > MAX_WRITE_BYTES) return failed(`the content exceeds ${MAX_WRITE_BYTES} bytes`);
    await assertWorkspaceIdentity(workspace);
    const path = await resolveInside(workspace.root, args.path);
    const existing = await lstat(path).catch(() => undefined);
    if (existing?.isSymbolicLink()) return failed(`the path is a link: ${args.path}`);
    // A FIFO, a device or a directory is refused before any open can block or write.
    if (existing !== undefined && !existing.isFile()) {
      return failed(`${args.path} is not a regular file`);
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return "link" as const;
      if ((error as NodeJS.ErrnoException).code === "ENXIO") return "fifo" as const;
      return "unwritable" as const;
    });
    if (handle === "link") return failed(`the path is a link: ${args.path}`);
    if (handle === "fifo") return failed(`${args.path} is not a regular file`);
    if (handle === "unwritable") return failed(`the file could not be written: ${args.path}`);
    try {
      // A FIFO that appeared after the check is caught on the handle itself.
      if (!(await handle.stat()).isFile()) return failed(`${args.path} is not a regular file`);
      // `mode` at open only applies to a new file: an overwrite is tightened explicitly.
      await handle.chmod(0o600);
      await handle.writeFile(args.content);
    } finally {
      await handle.close();
    }
    return { output: `wrote ${bytes} bytes to ${relativeTo(workspace.root, path)}` };
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
    await assertWorkspaceIdentity(workspace);
    const root = workspace.root;
    const start = await resolveInside(root, args.path ?? ".");
    const startInfo = await lstat(start).catch(() => undefined);
    if (startInfo === undefined) return failed(`no such path: ${args.path ?? "."}`);
    if (startInfo.isSymbolicLink()) return failed(`the path is a link: ${args.path ?? "."}`);
    if (startInfo.isFile()) return { output: args.path ?? "." };
    if (!startInfo.isDirectory()) return failed(`${args.path ?? "."} is not a directory`);

    const found: string[] = [];
    let bytes = 0;
    let truncated = false;
    const walk = async (directory: string): Promise<void> => {
      if (found.length >= limit) {
        truncated = true;
        return;
      }
      // Re-check the chain before every listing: a directory swapped for a link between
      // the walk and this call is refused rather than followed.
      await assertNoLinks(root, directory);
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        // A directory that cannot be listed is reported, never silently rendered empty.
        throw new ToolError(`the directory could not be listed: ${relativeTo(root, directory)}`);
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (found.length >= limit || bytes >= MAX_LIST_BYTES) {
          truncated = true;
          return;
        }
        // A link is shown so the model knows it is there, but never followed.
        const path = join(directory, entry.name);
        const shown = `${relative(root, path).split(sep).join("/")}${entry.isDirectory() ? "/" : ""}`;
        const size = Buffer.byteLength(shown) + (found.length === 0 ? 0 : 1);
        if (bytes + size > MAX_LIST_BYTES) {
          truncated = true;
          return;
        }
        bytes += size;
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
      output: truncated ? `${body}\n[truncated: showing the first ${found.length} entries]` : body,
    };
  } catch (error) {
    return failed(error instanceof ToolError ? error.message : "the workspace could not be listed");
  }
};
