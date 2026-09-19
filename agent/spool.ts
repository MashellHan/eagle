import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import { type Report, ReportSchema } from "../src/shared/schema.ts";
import { UploadRejectedError } from "./collector.ts";

export async function drainSpool(
  directory: string,
  machineId: string,
  send: (report: Report) => Promise<unknown>,
) {
  let sent = 0;
  const files = (await readdir(directory))
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const path = join(directory, file);
    try {
      const report = ReportSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (report.machine.id !== machineId) throw new UploadRejectedError(400);
      await send(report);
      await unlink(path);
      sent++;
    } catch (error) {
      if (
        !(
          error instanceof SyntaxError ||
          error instanceof ZodError ||
          (error instanceof UploadRejectedError &&
            [400, 409, 413, 415].includes(error.status))
        )
      )
        throw error;
      await mkdir(join(directory, "rejected"), {
        recursive: true,
        mode: 0o700,
      });
      await rename(path, join(directory, "rejected", file));
    }
  }
  const rejected = await readdir(join(directory, "rejected")).then(
    (f) => f.length,
    () => 0,
  );
  return { sent, rejected };
}
