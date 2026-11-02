import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

/**
 * The machine's own instructions, never written from the daemon: Eagle reads the file the
 * person's agent setup already maintains (docs/bots/PRODUCT.md, "Core prompts"). The first
 * candidate that exists with content wins, so the shared entry point comes before any one
 * tool's own copy.
 */
export const MACHINE_EXTENSION = "bots-machine";
export const MACHINE_SECTION = "bots-machine";

/** Relative to the home directory, in the order a machine publishes its instructions. */
export const MACHINE_PROMPT_CANDIDATES = [
  ".agents/AGENTS.md",
  ".pi/agent/AGENTS.md",
  ".codex/AGENTS.md",
  ".claude/CLAUDE.md",
] as const;

/** A machine file longer than this is cut: the prompt is not a place to paste a manual. */
export const MAX_MACHINE_PROMPT = 40_000;

export type MachinePrompt = {
  readonly path: string;
  readonly text: string;
};

/** The first instructions file with content, resolved through its symlink, or nothing. */
export const readMachinePrompt = (
  home: string = homedir(),
  candidates: readonly string[] = MACHINE_PROMPT_CANDIDATES,
): MachinePrompt | undefined => {
  for (const relative of candidates) {
    const path = isAbsolute(relative) ? relative : join(home, relative);
    let text: string;
    try {
      if (!existsSync(path)) continue;
      text = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    return {
      path: resolvedPath(path),
      text:
        text.length > MAX_MACHINE_PROMPT
          ? `${text.slice(0, MAX_MACHINE_PROMPT)}\n\n[truncated at ${MAX_MACHINE_PROMPT} characters]`
          : text,
    };
  }
  return undefined;
};

export const machineExtension = (read: () => MachinePrompt | undefined): Extension =>
  defineExtension({
    name: MACHINE_EXTENSION,
    tools: [],
    sections: [section(MACHINE_SECTION, () => read()?.text)],
  });

/** The file a person would open, not the link in their home directory. */
const resolvedPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
