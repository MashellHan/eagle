// Reported pull requests (docs/bots/EXTENSIONS-AND-TOOLS.md, coding group): one journal per
// bot, one row per URL, and a replayed report that never appends a second record.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_PULLS, PullStore, PullStoreError, pullJournalPath } from "../../src/core/PullStore.ts";

const withStore = async (run: (store: PullStore, path: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bots-pulls-"));
  try {
    const path = pullJournalPath(root);
    const store = await PullStore.open(path);
    await run(store, path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

let counter = 0;
const nextOpId = (): string => {
  counter += 1;
  return `task-${counter}`;
};

const report = (
  overrides: Partial<{ url: string; title: string; status: string; at: string }> = {},
) => ({
  opId: nextOpId(),
  url: "https://github.com/nocoo/eagle/pull/490",
  title: "v3.1.1 补丁版",
  status: "open",
  ...overrides,
});

test("one URL is one row: reporting it again updates that entry", async () => {
  await withStore(async (store) => {
    const first = await store.upsert(report());
    assert.equal(first.created, true);
    assert.equal(first.pull.host, "github.com");
    const second = await store.upsert(report({ status: "merged" }));
    assert.equal(second.created, false);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.status, "merged");
  });
});

test("the list is newest first, and any forge is kept verbatim", async () => {
  await withStore(async (store) => {
    await store.upsert(report({ at: "2026-10-30T10:00:00.000Z" }));
    await store.upsert(
      report({
        url: "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12",
        title: "fix: reconnect",
        status: "reviewing",
        at: "2026-10-30T11:00:00.000Z",
      }),
    );
    const pulls = store.list();
    assert.deepEqual(
      pulls.map((pull) => pull.host),
      ["dev.azure.com", "github.com"],
    );
    assert.equal(pulls[0]?.url, "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12");
  });
});

test("a replayed report answers with what it stored instead of appending again", async () => {
  await withStore(async (store, path) => {
    const input = report();
    const first = await store.upsert(input);
    const again = await store.upsert({ ...input, status: "closed" });
    assert.equal(again.pull.status, first.pull.status);
    assert.equal(store.list()[0]?.status, "open");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
  });
});

test("a link, a title and a status are each refused when they cannot be shown", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => store.upsert(report({ url: "not-a-link" })),
      (error: unknown) => error instanceof PullStoreError && error.reason === "invalid_url",
    );
    await assert.rejects(
      () => store.upsert(report({ url: "file:///etc/passwd" })),
      (error: unknown) => error instanceof PullStoreError && error.reason === "invalid_url",
    );
    await assert.rejects(
      () => store.upsert(report({ title: "  " })),
      (error: unknown) => error instanceof PullStoreError && error.reason === "invalid_title",
    );
    // The closed set is the tool's contract; the store only refuses a state it cannot show.
    await assert.rejects(
      () => store.upsert(report({ status: "  " })),
      (error: unknown) => error instanceof PullStoreError && error.reason === "invalid_status",
    );
  });
});

test("the panel keeps the newest reports and drops the oldest", async () => {
  await withStore(async (store) => {
    for (let index = 0; index < MAX_PULLS + 5; index += 1) {
      await store.upsert(
        report({
          url: `https://github.com/nocoo/eagle/pull/${500 + index}`,
          at: `2026-10-30T10:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      );
    }
    assert.equal(store.list().length, MAX_PULLS);
    assert.equal(store.list()[0]?.url.endsWith("/524"), true);
  });
});

test("a reopened store reads its journal, and an unreadable record is dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-pulls-"));
  try {
    const path = pullJournalPath(root);
    const store = await PullStore.open(path);
    await store.upsert(report());
    await writeFile(path, `${await readFile(path, "utf8")}{"op":"upsert"}\n`, { mode: 0o600 });

    let dropped = 0;
    const reopened = await PullStore.open(path, { onDropped: (count) => (dropped = count) });
    assert.equal(reopened.list().length, 1);
    assert.equal(dropped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a journal past its cap is compacted to one record per row on open", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-pulls-"));
  try {
    const path = pullJournalPath(root);
    const lines: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      lines.push(
        JSON.stringify({
          op: "upsert",
          opId: `seed-${index}`,
          at: `2026-10-30T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          pull: {
            url: `https://github.com/nocoo/eagle/pull/${index}`,
            title: `pull ${index}`,
            status: "open",
            host: "github.com",
            updatedAt: `2026-10-30T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
      );
    }
    await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });

    const store = await PullStore.open(path);
    const after = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(after.length, 205, "one record per row, not one per edit");
    // A report still narrows the panel to the newest rows.
    await store.upsert(report({ at: "2026-10-30T12:00:00.000Z" }));
    assert.equal(store.list().length, MAX_PULLS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
