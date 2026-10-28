import { relative, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";

const MAX_ENTRIES = 2_000;
const MAX_BYTES = 50 * 1024;
const EXCLUDED = new Set([".git", "node_modules", ".venv", "dist", ".build"]);

export const createListTool = () =>
  defineTool({
    name: "list",
    description:
      "List files and directories recursively, relative to the requested directory. Directories end with /. Does not traverse symbolic links or common build and dependency directories. Returns at most 2000 entries or 50KB.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Directory path (relative or absolute, default .)" }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_ENTRIES,
          description: "Maximum entries (default 2000)",
        }),
      ),
    }),
    replay: "safe",
    outputLimits: { maxBytes: MAX_BYTES, maxLines: MAX_ENTRIES, retain: "head" },
    async execute(args, api, context) {
      const env = api.env;
      if (env === undefined) throw new Error("No execution environment is configured");
      const limit = args.limit ?? MAX_ENTRIES;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ENTRIES) {
        throw new Error(`limit must be an integer between 1 and ${MAX_ENTRIES}`);
      }
      const root = getOrThrow(await env.absolutePath(args.path ?? ".", context));
      const found: string[] = [];
      let bytes = 0;
      let truncated = false;
      const walk = async (directory: string): Promise<void> => {
        const entries = getOrThrow(await env.listDir(directory, context));
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          const shown = `${relative(root, entry.path).split(sep).join("/")}${entry.kind === "directory" ? "/" : ""}`;
          const size = Buffer.byteLength(shown) + (found.length === 0 ? 0 : 1);
          if (found.length >= limit || bytes + size > MAX_BYTES) {
            truncated = true;
            return;
          }
          found.push(shown);
          bytes += size;
          if (entry.kind === "directory" && !EXCLUDED.has(entry.name)) await walk(entry.path);
          if (truncated) return;
        }
      };
      await walk(root);
      return {
        output: [
          { type: "text", text: found.length === 0 ? "(empty directory)" : found.join("\n") },
        ],
        ...(truncated
          ? {
              diagnostics: [
                {
                  severity: "info",
                  code: "truncated",
                  message: `Listing truncated after ${found.length} entries; list a subdirectory for more.`,
                },
              ],
            }
          : {}),
      };
    },
  });
