import { DurableObject } from "cloudflare:workers";

/** Control-plane index only. Each machine owns its metadata and authentication. */
export class MachineDirectory extends DurableObject<Env> {
  ids(): string[] {
    return [...this.ctx.storage.kv.list({ prefix: "machine:" })].map(([key]) =>
      key.slice(8),
    );
  }
  add(id: string): boolean {
    if (!this.ctx.storage.kv.get(`machine:${id}`) && this.ids().length >= 1000)
      return false;
    this.ctx.storage.kv.put(`machine:${id}`, true);
    return true;
  }
}
