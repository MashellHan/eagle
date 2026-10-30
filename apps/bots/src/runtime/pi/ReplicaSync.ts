import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  InboxDoc,
  type InputEntry,
  LiveDoc,
  type Submission,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { ClassifiedFailure } from "../../core/domain.ts";
import type { RuntimeHandle, SubmitInput } from "../../core/RuntimePort.ts";
import {
  bundleSchema,
  entrySchema,
  exportSchema,
  type HistoryBundle,
  type HistoryReplica,
  hash,
  validateBundle,
  validateHistory,
} from "./HistoryReplica.ts";
import {
  inputResources,
  RESOURCE_EXTENSION,
  RESOURCE_USER_KIND,
  type ResourceSelection,
  runResources,
} from "./HistoryResources.ts";
import { ReplicaStore } from "./ReplicaStore.ts";
import {
  bounded,
  type EntryFact,
  type Header,
  integer,
  keyOf,
  type Manifest,
  pageSchema,
  parse,
  runSchema,
  type Source,
  sourceKey,
  sourceSchema,
  syncReject,
} from "./syncProtocol.ts";

type Command = Parameters<NonNullable<RuntimeHandle["replica"]>>[0];

/** A short commit notification wakes a durable scan; it never constitutes an outbox receipt. */
export class ReplicaSync {
  readonly store: ReplicaStore;
  readonly #harness: Harness;
  readonly #history: HistoryReplica;
  readonly #rootId: ConversationId;
  readonly #report: (cause: unknown) => void;
  #reported = false;
  #tail: Promise<unknown> = Promise.resolve();
  #unsubscribe: (() => void) | undefined;
  #scheduled = false;
  #closed = false;
  #sessionClosed = false;

  constructor(
    path: string,
    botId: string,
    replicaId: string,
    harness: Harness,
    rootId: ConversationId,
    history: HistoryReplica,
    report: (cause: unknown) => void,
  ) {
    this.store = new ReplicaStore(path, botId, replicaId);
    this.#harness = harness;
    this.#history = history;
    this.#rootId = rootId;
    this.#report = report;
    this.store.conversation(rootId, null);
  }

  async start(): Promise<void> {
    this.#harness.subscribeClose(() => {
      this.#sessionClosed = true;
      this.#closed = true;
      this.#unsubscribe?.();
    });
    await this.prepareResources();
    await this.#drain();
    // Every pending version is prepared before the first submit can resume the scheduler.
    for (const intent of this.store.pending()) {
      if (intent.mode === "root" && intent.resourceHead !== undefined) {
        const existing = await this.#harness.commit(
          (tx) => tx.submissionByRequest(this.#rootId, intent.requestId),
          ctx,
        );
        if (existing !== undefined) continue;
        if (
          (await this.#history.installResources(this.#resourceBundle(intent.resourceHead))) !==
          intent.resourceVersion
        )
          syncReject("resource selection version mismatch");
      }
    }
    for (const intent of this.store.pending()) {
      if (intent.mode === "branch") await this.#run(intent);
      else {
        const root = await this.#harness.root(ctx);
        await this.root(
          {
            requestId: intent.requestId,
            text: intent.text,
            whenBusy: intent.whenBusy ?? "followUp",
            trace: "tr_replica_recovery",
            ...(intent.resourceHead === undefined ? {} : { resourceHead: intent.resourceHead }),
          },
          (entry) =>
            root.submit(
              {
                type: "input",
                requestId: intent.requestId,
                content: intent.text,
                whenBusy: intent.whenBusy ?? "followUp",
                ...(entry === undefined ? {} : { entry }),
              },
              ctx,
            ),
        );
      }
    }
    await this.#scan();
    this.#unsubscribe = this.#harness.subscribeCommits((publication) => {
      if (
        !publication.changes.some(
          (change) =>
            change.type === "entry" ||
            change.type === "task" ||
            (change.type === "document" && change.record.kind === AgentDoc.definition.kind),
        )
      )
        return;
      if (this.#scheduled || this.#closed) return;
      this.#scheduled = true;
      setImmediate(() => {
        this.#scheduled = false;
        if (!this.#closed)
          void this.#serial(async () => {
            if (this.#closed) return;
            await this.#scan();
            this.#reported = false;
          }).catch((cause) => this.#backgroundFailure(cause));
      });
    });
  }

  #backgroundFailure(cause: unknown): void {
    if (!this.#reported) {
      this.#reported = true;
      this.#report(cause);
    }
  }

  async prepareResources(): Promise<void> {
    await this.#history.prepareResources();
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    try {
      await this.#serial(async () => {
        if (!this.#sessionClosed) await this.#scan();
      });
    } catch (cause) {
      this.#backgroundFailure(cause);
    } finally {
      this.store.close();
    }
  }

  #resourceBundle(head: string): HistoryBundle {
    if (!this.store.ready(head)) return syncReject("resource head is not ready");
    const manifest = this.store.head(head) ?? syncReject("missing resource manifest");
    return this.#bundle(manifest) ?? syncReject("incomplete resource manifest");
  }

  checkRootRetry(input: Pick<SubmitInput, "requestId" | "whenBusy">) {
    const prior = this.store.run(input.requestId);
    if (
      prior !== undefined &&
      (prior.intent.mode !== "root" || (prior.intent.whenBusy ?? "followUp") !== input.whenBusy)
    )
      syncReject("local run request ID binding conflict");
    return prior;
  }

  root(
    input: SubmitInput,
    admit: (entry?: InputEntry) => Promise<Submission>,
  ): Promise<Submission> {
    return this.#serial(async () => {
      const prior = this.checkRootRetry(input);
      if (
        prior !== undefined &&
        (prior.intent.text !== input.text ||
          (input.resourceHead !== undefined && input.resourceHead !== prior.intent.resourceHead))
      )
        syncReject("local run request ID binding conflict");
      let selection: ResourceSelection | undefined;
      if (prior !== undefined) {
        if (prior.intent.resourceVersion !== undefined)
          selection = {
            resourceVersion: prior.intent.resourceVersion,
            ...(prior.intent.resourceHead === undefined
              ? {}
              : { resourceHead: prior.intent.resourceHead }),
          };
      } else if (input.resourceHead !== undefined) {
        const bundle = this.#resourceBundle(input.resourceHead);
        selection = {
          resourceHead: input.resourceHead,
          resourceVersion: bundle.resources.length === 0 ? "" : hash(bundle.resources),
        };
      } else if (input.whenBusy === "steer")
        selection = (await runResources(this.#harness, this.#rootId))?.selection;
      this.store.intent(
        prior?.intent ?? {
          kind: "run",
          mode: "root",
          requestId: input.requestId,
          head: prior === undefined ? this.store.latestHead(this.#rootId) : prior.intent.head,
          text: input.text,
          whenBusy: input.whenBusy,
          ...selection,
        },
      );
      try {
        const existing = await this.#harness.commit(
          (tx) => tx.submissionByRequest(this.#rootId, input.requestId),
          ctx,
        );
        if (existing !== undefined) {
          const submission = await this.#harness.submission(existing.id, ctx);
          if (submission === undefined) return syncReject("missing admitted root input");
          this.store.admitted(input.requestId);
          return submission;
        }
        if (selection?.resourceHead !== undefined)
          if (
            (await this.#history.installResources(this.#resourceBundle(selection.resourceHead))) !==
            selection.resourceVersion
          )
            syncReject("resource selection version mismatch");
        // SDK boundaries run while installation awaits: read current state after preflight.
        let checked = false;
        while (!checked) {
          const active = await runResources(this.#harness, this.#rootId);
          checked = await this.#harness.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, this.#rootId);
            if (live.run?.inputs[0] !== active?.id) return false;
            const inbox = await tx.doc(InboxDoc, this.#rootId);
            const version = selection?.resourceVersion ?? "";
            if (
              input.whenBusy === "steer" &&
              live.run !== undefined &&
              version !== (active?.selection?.resourceVersion ?? "")
            )
              syncReject("steer resource version differs from active run");
            for (const item of inbox.items) {
              if (item.mode === "write") continue;
              if (
                (input.whenBusy === "steer" || item.mode === "steer") &&
                version !== (inputResources(item.entry)?.resourceVersion ?? "")
              )
                syncReject("queued resource versions would share one run");
            }
            if (selection !== undefined) {
              const agent = await tx.doc(AgentDoc, this.#rootId);
              const extensions = agent.extensions;
              agent.extensions = Array.isArray(extensions)
                ? [...new Set([...extensions, RESOURCE_EXTENSION])]
                : {
                    ...extensions,
                    add: [...new Set([...(extensions?.add ?? []), RESOURCE_EXTENSION])],
                    ...(extensions?.remove === undefined
                      ? {}
                      : {
                          remove: extensions.remove.filter((name) => name !== RESOURCE_EXTENSION),
                        }),
                  };
            }
            return true;
          }, ctx);
        }
        const result = await admit(
          selection === undefined
            ? undefined
            : {
                kind: RESOURCE_USER_KIND,
                data: {
                  resourceVersion: selection.resourceVersion,
                  ...(selection.resourceHead === undefined
                    ? {}
                    : { resourceHead: selection.resourceHead }),
                },
              },
        );
        this.store.admitted(input.requestId);
        return result;
      } catch (error) {
        if (
          (error instanceof Error && error.name === "ConversationBusy") ||
          (error instanceof ClassifiedFailure && error.disposition === "not_admitted")
        )
          this.store.rejected(input.requestId);
        throw error;
      }
    });
  }

  command(command: Command): Promise<unknown> {
    return this.#serial(async () => {
      bounded(command.params);
      await this.#harness.commit(() => undefined, ctx);
      switch (command.method) {
        case "receipts":
          return this.#history.receipts(command.params);
        case "bind": {
          const { sharedBotId } = parse(z.strictObject({ sharedBotId: z.uuid() }), command.params);
          return this.store.bind(sharedBotId);
        }
        case "pull": {
          const input = parse(
            z.strictObject({
              source: sourceSchema.optional(),
              after: integer,
              limit: integer.min(1).max(128).default(128),
            }),
            command.params,
          );
          await this.#scan();
          const source =
            input.source ??
            sourceSchema.parse({
              replicaId: this.store.binding.replicaId,
              epoch: this.store.binding.epoch,
            });
          return this.store.page(source, input.after, input.limit);
        }
        case "apply": {
          const { page } = parse(z.strictObject({ page: pageSchema }), command.params);
          this.store.receive(page);
          await this.#drain(page.source);
          if (this.store.blocked(page.source) !== undefined)
            syncReject("source is blocked by invalid history");
          return this.store.status();
        }
        case "status": {
          const input = parse(z.strictObject({ requestId: z.string().optional() }), command.params);
          await this.#scan();
          return input.requestId === undefined
            ? this.store.status()
            : this.#history.command(command);
        }
        case "run": {
          const input = parse(runSchema, command.params);
          if (!this.store.ready(input.head)) {
            const bundle = validateBundle(
              await this.#history.command({
                method: "export",
                params: { head: input.head },
                trace: command.trace,
              }),
            );
            if (bundle.head !== input.head) syncReject("history receipt head mismatch");
            await this.#map(bundle);
            this.#index(bundle, false);
          }
          this.store.intent({ kind: "run", mode: "branch", ...input });
          return this.#run(input);
        }
        case "export": {
          const input = parse(exportSchema, command.params);
          let bundle: HistoryBundle;
          if (input.head !== undefined) {
            if (input.branch !== undefined) syncReject("select one immutable head");
            const manifest = this.store.head(input.head);
            if (manifest !== undefined && !this.store.ready(input.head))
              syncReject("history head is not ready");
            bundle =
              manifest === undefined
                ? validateBundle(
                    await this.#history.command({ ...command, params: { head: input.head } }),
                  )
                : await this.#history.carrier(
                    this.#bundle(manifest) ?? syncReject("incomplete history head"),
                  );
            if (input.resources !== undefined)
              bundle = await this.#history.exportResources(bundle, input.resources);
          } else if (input.branch !== undefined) {
            const branch = await this.#history.branch(input.branch);
            const manifest = branch === undefined ? undefined : this.store.head(branch.head);
            bundle =
              manifest === undefined
                ? validateBundle(await this.#history.command(command))
                : await this.#history.exportBranch(
                    this.#bundle(manifest) ?? syncReject("incomplete parent head"),
                    input,
                  );
          } else bundle = validateBundle(await this.#history.command(command));
          this.#index(bundle, bundle.source.replicaId === this.store.binding.replicaId);
          await this.#map(bundle);
          return bundle;
        }
        case "import": {
          const { bundle: value } = parse(z.strictObject({ bundle: z.unknown() }), command.params);
          const bundle = validateBundle(value);
          const result = await this.#history.command(command);
          this.#index(bundle, false);
          await this.#map(bundle);
          return result;
        }
      }
    });
  }

  async #run(intent: { requestId: string; head: string | null; text: string }): Promise<unknown> {
    try {
      const manifest = intent.head === null ? undefined : this.store.head(intent.head);
      if (manifest === undefined) return syncReject("missing run manifest");
      const result = await this.#history.runFrom(
        this.#bundle(manifest) ?? syncReject("incomplete run manifest"),
        { requestId: intent.requestId, head: intent.head, text: intent.text },
      );
      const branch = await this.#history.branch(intent.requestId);
      if (branch === undefined || branch.conversationId === 0)
        return syncReject("missing admitted branch");
      const parent = this.store.head(branch.head) ?? syncReject("missing branch parent");
      const receipt = await this.#history.receipt(parent.head);
      const tail = parent.entries.at(-1);
      this.store.conversation(
        branch.conversationId,
        branch.head,
        receipt?.entries[String(tail?.id)] ?? 0,
      );
      this.store.admitted(intent.requestId);
      return result;
    } catch (error) {
      if (
        (error instanceof Error && error.name === "ConversationBusy") ||
        (error instanceof ClassifiedFailure && error.disposition === "not_admitted")
      )
        this.store.rejected(intent.requestId);
      throw error;
    }
  }

  #fact(
    entry: HistoryBundle["entries"][number],
    origin: HistoryBundle["origins"][string],
  ): EntryFact {
    const dependencies: string[] = [];
    const dependency = (id: number) => {
      const header = this.store.localEntry(id) ?? syncReject("missing committed entry dependency");
      if (!dependencies.includes(header.ref)) dependencies.push(header.ref);
    };
    if (entry.head !== undefined && entry.head !== entry.id) dependency(entry.head);
    for (const edit of entry.edits ?? []) dependency(edit.target);
    return {
      kind: "entry",
      origin,
      content: {
        kind: entry.kind,
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(entry.data === undefined ? {} : { data: entry.data }),
        ...(entry.edits === undefined
          ? {}
          : { edits: entry.edits.map(({ target: _target, ...edit }) => edit) }),
      },
      dependencies,
    };
  }

  #header(entry: HistoryBundle["entries"][number], ref: string): Header {
    return {
      id: entry.id,
      conversationId: entry.conversationId,
      ...(entry.byTaskId === undefined ? {} : { byTaskId: entry.byTaskId }),
      ...(entry.head === undefined ? {} : { head: entry.head }),
      ref,
      ...(entry.edits === undefined ? {} : { targets: entry.edits.map((edit) => edit.target) }),
    };
  }

  #index(bundle: HistoryBundle, publish: boolean): Manifest {
    return this.store.transaction(() => {
      const headers = bundle.entries.map((entry) => {
        // Bundle IDs may be foreign: resolve dependencies within its own headers.
        const origin = bundle.origins[String(entry.id)];
        if (origin === undefined) return syncReject("missing source provenance");
        const dependencies = [
          ...(entry.head === undefined || entry.head === entry.id ? [] : [entry.head]),
          ...(entry.edits ?? []).map((edit) => edit.target),
        ].map((id) =>
          keyOf({
            kind: "entry",
            origin: bundle.origins[String(id)] ?? syncReject("missing source dependency"),
            content: { kind: "unused" },
            dependencies: [],
          }),
        );
        const fact: EntryFact = {
          kind: "entry",
          origin,
          content: {
            kind: entry.kind,
            ...(entry.model === undefined ? {} : { model: entry.model }),
            ...(entry.data === undefined ? {} : { data: entry.data }),
            ...(entry.edits === undefined
              ? {}
              : { edits: entry.edits.map(({ target: _target, ...edit }) => edit) }),
          },
          dependencies: [...new Set(dependencies)],
        };
        const ref = this.store.putFact(fact);
        if (publish && fact.origin.replicaId === this.store.binding.replicaId)
          this.store.append(`entry:${ref}`, fact);
        return this.#header(entry, ref);
      });
      const resources = bundle.resources.map((resource) => {
        const fact = { kind: "resource" as const, resource };
        const ref = this.store.putFact(fact);
        if (publish) this.store.append(`resource:${ref}`, fact);
        return ref;
      });
      const { entries: _entries, origins: _origins, resources: _resources, head, ...meta } = bundle;
      const manifest: Manifest = { kind: "head", head, meta, entries: headers, resources };
      this.store.putHead(manifest, true);
      if (publish) this.store.append(`head:${head}`, manifest);
      return manifest;
    });
  }

  async #map(bundle: HistoryBundle): Promise<void> {
    const mapped = await this.#history.checkedEntries(
      bundle,
      await this.#history.receipt(bundle.head),
    );
    const aliases = mapped.entries.map((entry, index) => {
      const original = bundle.entries[index] ?? syncReject("missing original receipt entry");
      return this.#header(
        entry,
        keyOf({
          kind: "entry",
          origin: bundle.origins[String(original.id)] ?? syncReject("missing origin"),
          content: { kind: "unused" },
          dependencies: [],
        }),
      );
    });
    this.store.transaction(() => {
      for (const header of aliases) this.store.remember(header);
      this.store.finishMaterialization(bundle.head, mapped.conversationId);
    });
  }

  #bundle(manifest: Manifest): HistoryBundle | undefined {
    // Complete P0 carriers are self-contained; their parent heads may be summaries only.
    if (
      !this.store.ready(manifest.head) &&
      manifest.meta.parents.some((head) => !this.store.ready(head))
    )
      return undefined;
    const entries: HistoryBundle["entries"] = [];
    const origins: HistoryBundle["origins"] = {};
    for (const header of manifest.entries) {
      const fact = this.store.fact(header.ref);
      if (fact === undefined || fact.kind !== "entry") return undefined;
      const { edits, ...content } = fact.content;
      if (
        (edits === undefined) !== (header.targets === undefined) ||
        (edits?.length ?? 0) !== (header.targets?.length ?? 0)
      )
        syncReject("invalid entry edit aliases");
      const { ref: _ref, targets: _targets, ...ids } = header;
      entries.push(
        parse(entrySchema, {
          ...ids,
          ...content,
          ...(edits === undefined
            ? {}
            : {
                edits: edits.map((edit, index) => ({ ...edit, target: header.targets?.[index] })),
              }),
        }),
      );
      origins[String(header.id)] = fact.origin;
    }
    const resources: HistoryBundle["resources"] = [];
    for (const ref of manifest.resources) {
      const fact = this.store.fact(ref);
      if (fact === undefined || fact.kind !== "resource") return undefined;
      resources.push(fact.resource);
    }
    return validateHistory(
      parse(bundleSchema, { ...manifest.meta, entries, origins, resources, head: manifest.head }),
    );
  }

  #prefix(manifest: Manifest): { head: string; entries: number[] } | null {
    const semantics = (entries: Header[]) => {
      const refs = new Map(entries.map((entry) => [entry.id, entry.ref]));
      return entries.map((entry) =>
        JSON.stringify({
          ref: entry.ref,
          head:
            entry.head === undefined
              ? null
              : entry.head === entry.id
                ? "self"
                : refs.get(entry.head),
          targets: entry.targets?.map((id) => refs.get(id)) ?? null,
        }),
      );
    };
    const wanted = semantics(manifest.entries);
    const candidate = this.store
      .readyHeads()
      .filter((head) => head.entries.length <= manifest.entries.length)
      .sort((a, b) => b.entries.length - a.entries.length)
      .find((head) => semantics(head.entries).every((entry, index) => entry === wanted[index]));
    return candidate === undefined
      ? null
      : { head: candidate.head, entries: candidate.entries.map((entry) => entry.id) };
  }

  async #drain(active?: Source): Promise<void> {
    let progress: boolean;
    do {
      progress = false;
      for (const source of this.store.sources()) {
        if (
          source.replicaId === this.store.binding.replicaId ||
          this.store.blocked(source) !== undefined
        )
          continue;
        let next = this.store.stream(source).applied + 1;
        try {
          for (
            let body = this.store.event(source, next);
            body !== undefined;
            body = this.store.event(source, next)
          ) {
            if (
              body.kind === "entry" &&
              body.dependencies.some((ref) => this.store.fact(ref) === undefined)
            )
              break;
            if (body.kind === "entry" || body.kind === "resource")
              this.store.transaction(() => {
                this.store.putFact(body);
                this.store.applied(source, next);
              });
            else if (body.kind === "head") {
              const bundle = this.#bundle(body);
              if (bundle === undefined) break;
              await this.#history.materialize(bundle, this.#prefix(body));
              await this.#map(bundle);
              this.store.transaction(() => {
                this.store.putHead(body, true);
                this.store.applied(source, next);
              });
            } else this.store.applied(source, next); // Foreign run facts never enter local_runs or the SDK.
            next += 1;
            progress = true;
          }
        } catch (cause) {
          if (!(cause instanceof ClassifiedFailure) || cause.failure.kind !== "invalid_command")
            throw cause;
          this.store.block(source, next);
          if (active !== undefined && sourceKey(active) === sourceKey(source)) throw cause;
          this.#report(cause);
        }
      }
    } while (progress);
  }

  async #scan(): Promise<void> {
    for (const conversation of this.store.conversations()) {
      let cursor: Cursor | undefined;
      do {
        const page = await this.#harness.commit(
          (tx) =>
            tx.scanEntries(
              {
                conversationId: conversation.id as ConversationId,
                minEntryId: (conversation.cursor + 1) as EntryId,
                order: "ascending",
              },
              128,
              cursor,
            ),
          ctx,
        );
        this.store.transaction(() => {
          for (const raw of page.items) {
            const entry = entrySchema.parse(raw);
            const fact = this.#fact(entry, {
              replicaId: this.store.binding.replicaId,
              conversationId: entry.conversationId,
              entryId: entry.id,
              ...(entry.byTaskId === undefined ? {} : { taskId: entry.byTaskId }),
            });
            const ref = this.store.putFact(fact);
            this.store.remember(this.#header(entry, ref));
            this.store.append(`entry:${ref}`, fact);
            this.store.cursor(conversation.id, entry.id);
          }
        });
        cursor = page.next;
      } while (cursor !== undefined);
      const fixedParent =
        conversation.parent === null ? undefined : await this.#history.receipt(conversation.parent);
      const state = await this.#harness.commit(async (tx) => {
        let ancestor: ConversationId | undefined = conversation.id as ConversationId;
        let checkBusy = true;
        while (ancestor !== undefined) {
          if (ancestor === fixedParent?.conversationId) checkBusy = false;
          let tasks: Cursor | undefined;
          do {
            const page = await tx.scanTasks({ conversationId: ancestor }, 128, tasks);
            if (
              page.items.some(
                (task) =>
                  (checkBusy && task.state.status !== "terminal") ||
                  (task.kind === "pi.tool" &&
                    task.input !== null &&
                    typeof task.input === "object" &&
                    !Array.isArray(task.input) &&
                    task.input.kind === "nested"),
              )
            )
              return undefined;
            tasks = page.next;
          } while (tasks !== undefined);
          ancestor = (await tx.conversation(ancestor))?.parent?.conversationId;
        }
        const tail = await tx.scanEntries(
          { conversationId: conversation.id as ConversationId, order: "descending" },
          1,
        );
        return {
          agent: JSON.parse(
            JSON.stringify(await tx.doc(AgentDoc, conversation.id as ConversationId)),
          ),
          tail: tail.items[0]?.id,
        };
      }, ctx);
      if (state === undefined) continue;
      const own = this.store.entries(conversation.id);
      const parent =
        conversation.parent === null ? undefined : this.store.head(conversation.parent);
      const receipt = parent === undefined ? undefined : await this.#history.receipt(parent.head);
      const inherited = (parent?.entries ?? []).map(
        (entry) =>
          this.store.localEntry(receipt?.entries[String(entry.id)] ?? 0) ??
          syncReject("missing pinned parent entry mapping"),
      );
      const headers = [...inherited, ...own].sort((a, b) => a.id - b.id);
      if (headers.length === 0 || headers.at(-1)?.id !== state.tail) continue;
      const resourceHead = this.store.latestHead(conversation.id) ?? conversation.parent;
      const resources =
        resourceHead === null
          ? []
          : this.#bundle(
              this.store.head(resourceHead) ?? syncReject("missing resource version head"),
            )?.resources;
      const signature = hash({ headers, agent: state.agent, resources });
      if (signature === conversation.signature) continue;
      const entries: HistoryBundle["entries"] = [];
      const origins: HistoryBundle["origins"] = {};
      for (const header of headers) {
        const fact = this.store.fact(header.ref);
        if (fact === undefined || fact.kind !== "entry")
          return syncReject("missing local committed fact");
        const { edits, ...content } = fact.content;
        const { ref: _ref, targets, ...ids } = header;
        entries.push(
          entrySchema.parse({
            ...ids,
            ...content,
            ...(edits === undefined
              ? {}
              : { edits: edits.map((edit, index) => ({ ...edit, target: targets?.[index] })) }),
          }),
        );
        origins[String(header.id)] = fact.origin;
      }
      const payload = bundleSchema.omit({ head: true }).parse({
        version: 1,
        engine: "pi-durable@1.4.0",
        source: {
          replicaId: this.store.binding.replicaId,
          botId: this.store.binding.localBotId,
          conversationId: conversation.id,
        },
        parents: conversation.parent === null ? [] : [conversation.parent],
        entries,
        origins,
        agent: state.agent,
        resources: resources ?? [],
      });
      const bundle = validateHistory({ ...payload, head: hash(payload) });
      await this.#history.pinLocal(bundle);
      this.#index(bundle, true);
      await this.#map(bundle);
      this.store.signature(conversation.id, signature);
    }
    this.#reported = false;
  }
}
