import { DurableObject } from "cloudflare:workers";
import { type DailySettings, DailySettingsSchema } from "../shared/daily.ts";
import {
  type MachineGroup,
  MachineGroupInput,
  type MachineGroupState,
} from "../shared/machine-groups.ts";
import { aiEndpoint, sealAiKey, unsealAiKey } from "./ai-secret.ts";

/** Control-plane index only. Each machine owns its metadata and authentication. */
export class MachineDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const old = ctx.storage.kv.get<Record<string, unknown>>("hourly-settings");
    if (old) {
      const { intervalHours: _interval, ...settings } = old;
      ctx.storage.kv.put("daily-settings", DailySettingsSchema.parse(settings));
      ctx.storage.kv.delete("hourly-settings");
    }
  }
  settings(): DailySettings {
    return DailySettingsSchema.parse(
      this.ctx.storage.kv.get("daily-settings") ?? {},
    );
  }
  async aiKey(settings: DailySettings = this.settings()): Promise<string> {
    const value =
      this.ctx.storage.kv.get<Awaited<ReturnType<typeof sealAiKey>>>(
        "ai-credential",
      );
    if (!value || value.endpoint !== aiEndpoint(settings)) return "";
    return unsealAiKey(value, this.env.AI_ENCRYPTION_KEY, aiEndpoint(settings));
  }
  async saveSettings(
    settings: DailySettings,
    apiKey?: string | null,
  ): Promise<DailySettings> {
    const value = DailySettingsSchema.parse(settings);
    const endpoint = aiEndpoint(value);
    const credential = apiKey
      ? await sealAiKey(apiKey, this.env.AI_ENCRYPTION_KEY, endpoint)
      : apiKey === null || endpoint !== aiEndpoint(this.settings())
        ? null
        : undefined;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("daily-settings", value);
      if (credential === null) this.ctx.storage.kv.delete("ai-credential");
      else if (credential !== undefined)
        this.ctx.storage.kv.put("ai-credential", credential);
    });
    return value;
  }
  ids(): string[] {
    return [...this.ctx.storage.kv.list({ prefix: "machine:" })].map(([key]) =>
      key.slice(8),
    );
  }
  deletedIds(): string[] {
    return [...this.ctx.storage.kv.list({ prefix: "deleted:" })].map(([key]) =>
      key.slice(8),
    );
  }
  add(id: string): boolean {
    this.ctx.storage.kv.delete(`deleted:${id}`);
    if (!this.ctx.storage.kv.get(`machine:${id}`) && this.ids().length >= 1000)
      return false;
    this.ctx.storage.kv.put(`machine:${id}`, true);
    return true;
  }
  remove(id: string): void {
    this.ctx.storage.kv.delete(`machine:${id}`);
    this.ctx.storage.kv.delete(`assignment:${id}`);
  }
  markDeleted(id: string): void {
    this.ctx.storage.kv.put(`deleted:${id}`, true);
  }
  groups(): MachineGroup[] {
    return this.ctx.storage.kv.get<MachineGroup[]>("machine-groups") ?? [];
  }
  private saveGroups(groups: MachineGroup[]) {
    this.ctx.storage.kv.put("machine-groups", groups);
  }
  machineGroups(ids: string[]): MachineGroupState {
    const assignments: Record<string, string | null> = {};
    for (const id of ids) {
      const value = this.ctx.storage.kv.get<string>(`assignment:${id}`);
      assignments[id] = value ?? null;
    }
    return { groups: this.groups(), assignments };
  }
  createGroup(name: string): MachineGroup {
    const parsed = MachineGroupInput.parse({ name });
    const group = { id: crypto.randomUUID(), name: parsed.name };
    this.saveGroups([...this.groups(), group]);
    return group;
  }
  renameGroup(id: string, name: string): MachineGroup | null {
    const parsed = MachineGroupInput.parse({ name });
    const groups = this.groups();
    const index = groups.findIndex((group) => group.id === id);
    if (index < 0) return null;
    const next = [...groups];
    next[index] = { ...next[index], name: parsed.name };
    this.saveGroups(next);
    return next[index];
  }
  deleteGroup(id: string): boolean {
    const groups = this.groups();
    if (!groups.some((group) => group.id === id)) return false;
    this.saveGroups(groups.filter((group) => group.id !== id));
    for (const [key] of this.ctx.storage.kv.list({ prefix: "assignment:" })) {
      if (this.ctx.storage.kv.get<string>(key) === id)
        this.ctx.storage.kv.delete(key);
    }
    return true;
  }
  setAssignment(machineId: string, groupId: string | null): boolean {
    if (
      groupId !== null &&
      !this.groups().some((group) => group.id === groupId)
    )
      return false;
    if (groupId === null) this.ctx.storage.kv.delete(`assignment:${machineId}`);
    else this.ctx.storage.kv.put(`assignment:${machineId}`, groupId);
    return true;
  }
}
