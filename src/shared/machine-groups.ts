import { z } from "zod";

export const DEFAULT_MACHINE_GROUP_NAME = "机器";

export const MachineGroupInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
});

export type MachineGroup = { id: string; name: string };

export type MachineGroupState = {
  groups: MachineGroup[];
  assignments: Record<string, string | null>;
};

export function machinesBySidebarGroup<T extends { id: string }>(
  machines: T[],
  state: MachineGroupState,
): { name: string; machines: T[] }[] {
  const groupIds = new Set(state.groups.map((group) => group.id));
  const sections: { name: string; machines: T[] }[] = [];
  for (const group of state.groups) {
    const members = machines
      .filter((machine) => state.assignments[machine.id] === group.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (members.length) sections.push({ name: group.name, machines: members });
  }
  const defaultMembers = machines
    .filter((machine) => {
      const assigned = state.assignments[machine.id];
      return assigned === null || assigned === undefined || !groupIds.has(assigned);
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (defaultMembers.length)
    sections.push({ name: DEFAULT_MACHINE_GROUP_NAME, machines: defaultMembers });
  return sections;
}
