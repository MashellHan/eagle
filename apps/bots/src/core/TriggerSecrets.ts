// Webhook credentials (docs/bots/TRIGGERS.md §9.2): one bearer token per webhook trigger,
// 0600, never logged, never in the model's context and never in a URL. The daemon bearer
// still guards the app's own API; this token guards one delivery endpoint.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const triggerSecretsPath = (botDir: string): string => `${botDir}/triggers.secrets.json`;

export class TriggerSecretStore {
  readonly #path: string;
  readonly #tokens: Map<string, string>;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, tokens: Map<string, string>) {
    this.#path = path;
    this.#tokens = tokens;
  }

  static async open(path: string): Promise<TriggerSecretStore> {
    let body = "";
    try {
      body = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const tokens = new Map<string, string>();
    if (body.trim().length > 0) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        for (const [id, value] of Object.entries(parsed)) {
          if (typeof value === "string" && value.length > 0) tokens.set(id, value);
        }
      } catch {
        // A corrupt file is replaced on the next write: an unrecoverable token is worse
        // than a new one, and the old endpoint simply stops accepting deliveries.
      }
    }
    return new TriggerSecretStore(path, tokens);
  }

  /** The token for one trigger, generated and persisted on first use. */
  tokenFor(triggerId: string): Promise<string> {
    const known = this.#tokens.get(triggerId);
    if (known !== undefined) return Promise.resolve(known);
    const token = randomBytes(32).toString("base64url");
    this.#tokens.set(triggerId, token);
    return this.#persist().then(() => token);
  }

  /** Constant-time compare; an unknown trigger never matches, including with an empty token. */
  matches(triggerId: string, candidate: string): boolean {
    const known = this.#tokens.get(triggerId);
    if (known === undefined || candidate.length === 0) return false;
    const left = Buffer.from(known, "utf8");
    const right = Buffer.from(candidate, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  /** Every token this store knows, for the log's redaction list. */
  tokens(): readonly string[] {
    return [...this.#tokens.values()];
  }

  forget(triggerId: string): Promise<void> {
    if (!this.#tokens.delete(triggerId)) return Promise.resolve();
    return this.#persist();
  }

  #persist(): Promise<void> {
    const body = `${JSON.stringify(Object.fromEntries(this.#tokens), null, 2)}\n`;
    const write = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#queue = write.catch(() => undefined);
    return write;
  }
}
