import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Draft, DraftController } from "@/features/discussions/draft";
import {
  DraftMovedError,
  draftDatabase,
  OwnedDraftStore,
} from "@/features/discussions/draft-storage";
import { backend } from "@/lib/backend";

const browserUuid = vi.hoisted(() => ({ path: "" }));
vi.mock("uuid", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const packagePath = createRequire(import.meta.url).resolve(
    "uuid/package.json",
  );
  browserUuid.path = resolve(dirname(packagePath), "dist/index.js");
  vi.stubGlobal("crypto", {});
  return import(pathToFileURL(browserUuid.path).href);
});

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const prefix = "organization:1:2:";
function draft(key = `${prefix}source`, body = "Saved message"): Draft {
  return {
    key,
    updatedAt: 12,
    body,
    bodyRevision: 7,
    files: [],
    pending: null,
  };
}

async function read(key: string) {
  const db = await draftDatabase();
  try {
    return await db.get("drafts", key);
  } finally {
    db.close();
  }
}

async function seed(value: Draft) {
  const db = await draftDatabase();
  try {
    await db.put("drafts", value);
  } finally {
    db.close();
  }
}

async function store(name: string) {
  const storage = new OwnedDraftStore(
    `${prefix}${name}`,
    prefix,
    `owner-${name}`,
  );
  const initial = await storage.open(draft(storage.key, ""));
  return { storage, initial };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("clears busy when browser UUID generation has no secure random source", async () => {
  vi.stubGlobal("crypto", {});
  const controller = new DraftController(2, draft());
  const send = vi.fn(async () => true);
  await controller.send(send);
  expect(browserUuid.path).toMatch(/\/uuid\/dist\/index\.js$/);
  expect(controller.snapshot().busy).toBe(false);
  expect(controller.snapshot().draft.body).toBe("Saved message");
  expect(controller.snapshot().error).toContain(
    "getRandomValues() not supported",
  );
  expect(send).not.toHaveBeenCalled();
});

it("creates browser UUID v4 identities with randomUUID completely absent", async () => {
  const { storage, initial } = await store("target");
  expect(crypto.randomUUID).toBeUndefined();
  expect(initial.storageRevision).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const controller = new DraftController(2, initial, () => {}, storage);
  controller.addFiles([new File(["content"], "attachment.txt")]);
  await vi.waitFor(() => expect(controller.snapshot().saving).toBe(false));
  const item = controller.snapshot().draft.files[0];
  expect(item.id).toMatch(/^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  expect(item.clientId).not.toBe(item.id);
  controller.setBody("HTTP message");
  await vi.waitFor(() => expect(controller.snapshot().saving).toBe(false));
  controller.removeFile(item.id);
  await vi.waitFor(() => expect(controller.snapshot().saving).toBe(false));
  const send = vi.fn(async () => false);
  await controller.send(send);
  const submission = controller.snapshot().draft.pending;
  expect(submission?.id).toMatch(/^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  vi.spyOn(backend, "sendStatus").mockResolvedValue({
    state: "unknown",
    message: null,
  });
  await controller.send(send);
  expect(send).toHaveBeenLastCalledWith("HTTP message", [], submission?.id);
  expect(controller.snapshot().draft.pending?.id).toBe(submission?.id);
});

it("creates independent owned keys without adopting another saved draft", async () => {
  const previous = draft();
  await seed(previous);
  const first = await store("first");
  const second = await store("second");
  expect(first.initial.body).toBe("");
  expect(second.initial.body).toBe("");
  expect(first.initial.owner).not.toBe(second.initial.owner);
  expect(await read(previous.key)).toMatchObject(previous);
  expect(await first.storage.open(draft(first.storage.key, ""))).toEqual(
    first.initial,
  );
  const collision = new OwnedDraftStore(
    first.storage.key,
    prefix,
    "other-owner",
  );
  await expect(
    collision.open(draft(first.storage.key, "")),
  ).rejects.toBeInstanceOf(DraftMovedError);
});

it("initializes one persistent legacy revision across concurrent connections", async () => {
  const previous = {
    ...draft(),
    voiceSubmission: { id: "voice", submittedBody: "Saved" },
    pending: {
      id: "pending-id",
      body: "Original",
      bodyRevision: 5,
      files: [],
      phase: "sending" as const,
    },
  };
  await seed(previous);
  const first = await store("first");
  const second = await store("second");
  const [left, right] = await Promise.all([
    first.storage.candidates(),
    second.storage.candidates(),
  ]);
  expect(left[0].storageRevision).toBeTruthy();
  expect(left[0].storageRevision).toBe(right[0].storageRevision);
  expect(await read(previous.key)).toEqual({
    ...previous,
    storageRevision: left[0].storageRevision,
  });
});

it("does not publish legacy candidates or change data when initialization aborts", async () => {
  const previous = draft();
  await seed(previous);
  const target = await store("target");
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<typeof original>
  ) {
    const request = original.apply(this, args);
    this.transaction.abort();
    return request;
  });
  const publish = vi.fn();
  await expect(target.storage.candidates().then(publish)).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
  expect(await read(previous.key)).toEqual(previous);
});

it("permits one of two concurrent recoveries and preserves pending identity", async () => {
  const previous = {
    ...draft(),
    owner: "old-owner",
    storageRevision: "old-revision",
    pending: {
      id: "send-id",
      body: "Original",
      bodyRevision: 3,
      files: [],
      phase: "sending" as const,
    },
  };
  await seed(previous);
  const first = await store("first");
  const second = await store("second");
  const candidate = (await first.storage.candidates())[0];
  const results = await Promise.allSettled([
    first.storage.recover(candidate, () => true),
    second.storage.recover(candidate, () => true),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(await read(previous.key)).toBeUndefined();
  const copies = [
    await read(first.storage.key),
    await read(second.storage.key),
  ];
  expect(copies.filter((copy) => copy?.pending?.id === "send-id")).toHaveLength(
    1,
  );
  const recovered = copies.find((copy) => copy?.pending);
  expect(recovered?.pending).toEqual(previous.pending);
  expect(recovered?.bodyRevision).toBe(previous.bodyRevision);
});

it("keeps the recovered snapshot when saving is retried before the migration commits", async () => {
  vi.stubGlobal("window", {});
  const file = new File(["attachment"], "saved.txt");
  const item = { id: "file-id", clientId: "client-id", file };
  const previous: Draft = {
    ...draft(),
    files: [item],
    pending: {
      id: "original-send-id",
      body: "Original send",
      bodyRevision: 5,
      files: [item],
      phase: "uploading",
    },
  };
  await seed(previous);
  const target = await store("target");
  const controller = new DraftController(
    2,
    target.initial,
    () => {},
    target.storage,
  );
  const candidates = await target.storage.candidates();
  const lateCandidates = deferred<Draft[]>();
  vi.spyOn(target.storage, "candidates").mockReturnValueOnce(
    lateCandidates.promise,
  );
  const refreshing = controller.refreshRecovery();
  const save = vi.spyOn(target.storage, "save");
  save.mockRejectedValueOnce(new Error("Storage unavailable"));
  controller.saveAgain();
  await vi.waitFor(() => expect(controller.snapshot().saving).toBe(false));
  expect(controller.snapshot().storageError).toContain("Storage unavailable");
  lateCandidates.resolve(candidates);
  await refreshing;
  const original = IDBObjectStore.prototype.put;
  const duringMigration = vi.fn();
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<typeof original>
  ) {
    const value = args[0] as Draft;
    if (
      value.key === target.storage.key &&
      value.pending?.id === "original-send-id"
    ) {
      duringMigration();
      expect(controller.snapshot().recovering).toBe(true);
      controller.saveAgain();
      controller.setBody("Late body");
      controller.setVoiceBody("Late voice", null);
      controller.addFiles([new File(["late"], "late.txt")]);
      controller.removeFile("file-id");
      controller.cancel();
    }
    return original.apply(this, args);
  });
  await controller.recover();
  await vi.waitFor(() => expect(controller.snapshot().saving).toBe(false));
  expect(duringMigration).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
  expect(await read(previous.key)).toBeUndefined();
  const recovered = await read(target.storage.key);
  expect(recovered).toMatchObject({
    body: previous.body,
    bodyRevision: previous.bodyRevision,
    files: previous.files,
    pending: previous.pending,
  });
  expect(controller.snapshot().draft).toEqual(recovered);
  expect(controller.snapshot().storageError).toBeNull();
  expect(controller.snapshot().recovering).toBe(false);
  expect(controller.canRelease()).toBe(true);
});

it("rejects changed candidate revisions and a target that started editing", async () => {
  await seed(draft());
  const target = await store("target");
  const candidate = (await target.storage.candidates())[0];
  await seed({ ...candidate, storageRevision: "new-version", body: "Changed" });
  await expect(target.storage.recover(candidate, () => true)).rejects.toThrow(
    "changed",
  );
  const latest = (await target.storage.candidates())[0];
  await target.storage.save({ ...target.initial, body: "Target edit" });
  await expect(target.storage.recover(latest, () => true)).rejects.toThrow(
    "no longer empty",
  );
  expect((await read(latest.key))?.body).toBe("Changed");
  expect((await read(target.storage.key))?.body).toBe("Target edit");
});

it("rejects local edits begun after the empty target was persisted", async () => {
  await seed(draft());
  const target = await store("target");
  const candidate = (await target.storage.candidates())[0];
  await expect(target.storage.recover(candidate, () => false)).rejects.toThrow(
    "no longer empty",
  );
  expect(await read(candidate.key)).toBeDefined();
});

it("does not recreate a moved key from any queued save or later input", async () => {
  const source = await store("source");
  const saved = await source.storage.save({
    ...source.initial,
    body: "Original",
  });
  const controller = new DraftController(2, saved, () => {}, source.storage);
  const target = await store("target");
  const candidate = (await target.storage.candidates())[0];
  await target.storage.recover(candidate, () => true);
  controller.setBody("Unsaved edit");
  controller.saveAgain();
  controller.removeFile("missing");
  await vi.waitFor(() => expect(controller.snapshot().moved).toBe(true));
  controller.setBody("Later edit");
  controller.addFiles([new File(["data"], "later.txt")]);
  controller.cancel();
  await controller.connectionRestored();
  expect(controller.snapshot().draft.body).toBe("Unsaved edit");
  expect(controller.snapshot().busy).toBe(false);
  expect(await read(source.storage.key)).toBeUndefined();
  expect((await read(target.storage.key))?.body).toBe("Original");
});

it("stops an old receipt and later network calls after an explicit move", async () => {
  const source = await store("source");
  const saved = await source.storage.save({
    ...source.initial,
    body: "Message",
  });
  const controller = new DraftController(2, saved, () => {}, source.storage);
  const response = deferred<boolean>();
  const send = vi.fn(() => response.promise);
  const operation = controller.send(send);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  const pendingId = controller.snapshot().draft.pending?.id;
  const target = await store("target");
  await target.storage.recover(
    (await target.storage.candidates())[0],
    () => true,
  );
  response.resolve(true);
  await operation;
  await controller.send(send);
  await controller.discardAttempt();
  await controller.checkResult();
  expect(controller.snapshot().moved).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(await read(source.storage.key)).toBeUndefined();
  expect((await read(target.storage.key))?.pending?.id).toBe(pendingId);
});

it("records the allowed network window after a completed ownership check", async () => {
  const source = await store("source");
  const saved = await source.storage.save({
    ...source.initial,
    body: "Message",
  });
  const controller = new DraftController(2, saved, () => {}, source.storage);
  const checked = deferred<void>();
  const resume = deferred<void>();
  const original = source.storage.assertOwner.bind(source.storage);
  let checks = 0;
  vi.spyOn(source.storage, "assertOwner").mockImplementation(async () => {
    await original();
    if (++checks === 2) {
      checked.resolve();
      await resume.promise;
    }
  });
  const send = vi.fn(async () => true);
  const operation = controller.send(send);
  await checked.promise;
  const target = await store("target");
  await target.storage.recover(
    (await target.storage.candidates())[0],
    () => true,
  );
  resume.resolve();
  await operation;
  expect(send).toHaveBeenCalledOnce();
  expect(controller.snapshot().moved).toBe(true);
  expect(await read(source.storage.key)).toBeUndefined();
  expect((await read(target.storage.key))?.pending?.phase).toBe("sending");
});

it("stops a late upload without cancelling attachments owned by the new tab", async () => {
  const source = await store("source");
  const saved = await source.storage.save({
    ...source.initial,
    body: "Message",
    files: [
      {
        id: "file",
        clientId: "client",
        file: new File(["content"], "one.txt"),
      },
    ],
  });
  const controller = new DraftController(2, saved, () => {}, source.storage);
  vi.spyOn(backend, "createUpload").mockResolvedValue({
    id: "upload",
    state: "reserved",
    expires_at: Date.now() / 1000 + 3600,
  });
  const uploaded = deferred<Awaited<ReturnType<typeof backend.uploadFile>>>();
  vi.spyOn(backend, "uploadFile").mockReturnValue(uploaded.promise);
  vi.spyOn(backend, "cancelUploads").mockResolvedValue({ cancelled: 1 });
  const send = vi.fn(async () => true);
  const operation = controller.send(send);
  await vi.waitFor(() => expect(backend.uploadFile).toHaveBeenCalledOnce());
  const target = await store("target");
  await target.storage.recover(
    (await target.storage.candidates())[0],
    () => true,
  );
  uploaded.resolve({ id: "upload" } as Awaited<
    ReturnType<typeof backend.uploadFile>
  >);
  await operation;
  await controller.connectionRestored();
  await controller.discardAttempt();
  expect(controller.snapshot().moved).toBe(true);
  expect(backend.cancelUploads).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(await read(source.storage.key)).toBeUndefined();
  expect((await read(target.storage.key))?.pending?.files[0].upload?.id).toBe(
    "upload",
  );
});

it("does not finish old cancellation or regenerate identities after a move", async () => {
  const source = await store("source");
  const file = new File(["content"], "one.txt");
  const upload = {
    id: "upload",
    state: "reserved" as const,
    expires_at: Date.now() / 1000 + 3600,
  };
  const item = { id: "file", clientId: "client", file, upload };
  const saved = await source.storage.save({
    ...source.initial,
    body: "Message",
    files: [item],
    pending: {
      id: "cancel",
      body: "Message",
      bodyRevision: 7,
      files: [item],
      phase: "uploading",
      cancelRequested: true,
    },
  });
  const controller = new DraftController(2, saved, () => {}, source.storage);
  const cancelled = deferred<{ cancelled: number }>();
  vi.spyOn(backend, "cancelUploads").mockReturnValue(cancelled.promise);
  const operation = controller.checkResult();
  await vi.waitFor(() => expect(backend.cancelUploads).toHaveBeenCalledOnce());
  const target = await store("target");
  await target.storage.recover(
    (await target.storage.candidates())[0],
    () => true,
  );
  cancelled.resolve({ cancelled: 1 });
  await operation;
  await controller.connectionRestored();
  expect(controller.snapshot().moved).toBe(true);
  expect(backend.cancelUploads).toHaveBeenCalledOnce();
  expect(await read(source.storage.key)).toBeUndefined();
  const recovered = await read(target.storage.key);
  expect(recovered?.pending?.id).toBe("cancel");
  expect(recovered?.files[0].clientId).toBe("client");
});

it("generates a fresh browser client identity for expired uploads and completed cancellation", async () => {
  const source = await store("source");
  const file = new File(["content"], "one.txt");
  const expired = { id: "expired", state: "ready" as const, expires_at: 1 };
  const saved = await source.storage.save({
    ...source.initial,
    body: "Message",
    files: [{ id: "file", clientId: "old-client", file, upload: expired }],
  });
  const controller = new DraftController(2, saved, () => {}, source.storage);
  vi.spyOn(backend, "uploadStatus").mockResolvedValue([expired]);
  vi.spyOn(backend, "cancelUploads").mockResolvedValue({ cancelled: 1 });
  vi.spyOn(backend, "createUpload").mockResolvedValue({
    id: "fresh",
    state: "ready",
    expires_at: Date.now() / 1000 + 3600,
  });
  vi.spyOn(backend, "uploadFile").mockResolvedValue({ id: "fresh" } as Awaited<
    ReturnType<typeof backend.uploadFile>
  >);
  await controller.send(vi.fn(async () => false));
  const refreshed = controller.snapshot().draft.pending?.files[0].clientId;
  expect(refreshed).not.toBe("old-client");
  expect(refreshed).toMatch(/^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  vi.spyOn(backend, "cancelSend").mockResolvedValue({
    state: "cancelled",
    message: null,
  });
  await controller.discardAttempt();
  expect(controller.snapshot().draft.pending).toBeNull();
  expect(controller.snapshot().draft.files[0].clientId).not.toBe(refreshed);
  expect(controller.snapshot().draft.files[0].clientId).toMatch(
    /^[0-9a-f-]{14}4[0-9a-f-]{21}$/,
  );
});
