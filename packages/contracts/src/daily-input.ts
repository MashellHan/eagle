import { type InputRecord, projectHour } from "./report-input.ts";

export const dailyDate = (at: string | number) =>
  new Date(new Date(at).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export const dailyStart = (date: string) =>
  new Date(`${date}T00:00:00+08:00`).toISOString();
export const dailyCutoff = (date: string) =>
  new Date(`${date}T23:59:00+08:00`).toISOString();
export const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00+08:00`)) &&
  dailyDate(dailyStart(date)) === date;
export const dueDate = (at: number) => dailyDate(at - 86340000);

export function sampleHour(input: InputRecord[], hour: number) {
  const projected = projectHour(input).records;
  const ordered = projected.toSorted(
    (a, b) =>
      (b.observations.at(-1) ?? "").localeCompare(
        a.observations.at(-1) ?? "",
      ) || a.id.localeCompare(b.id),
  );
  const records: InputRecord[] = [];
  let excerptedRecords = 0;
  for (const source of ordered) {
    const value = source.value;
    const excerpted = value.length > 1000;
    const record = {
      ...source,
      id: `H${String(hour).padStart(2, "0")}-${source.id}`,
      observations: [
        ...new Set(
          [source.observations[0], source.observations.at(-1)].filter(
            (v): v is string => !!v,
          ),
        ),
      ],
      value: excerpted ? `${value.slice(0, 1000)}… [excerpt]` : value,
    };
    if (JSON.stringify([...records, record]).length > 4000) continue;
    records.push(record);
    if (excerpted) excerptedRecords++;
  }
  return {
    records,
    omittedRecords: input.length - records.length,
    excerptedRecords,
  };
}
