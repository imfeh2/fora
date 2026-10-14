import { describe, expect, it, vi } from "vitest";
import {
  GenerationResource,
  type GenerationSnapshot,
  validateGenerationText,
} from "@/features/generation-resource";
import { BackendError, type GenerationTextPage } from "@/lib/backend";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function text(value: string, revision = 1, offset = 0, total?: number) {
  const end = offset + new TextEncoder().encode(value).length;
  return {
    revision,
    offset,
    next_offset: end,
    total_bytes: total ?? end,
    value,
    has_more: end < (total ?? end),
  };
}
function snapshot(value = "中文", revision = 1, total?: number) {
  return { metadata: { revision }, text: text(value, revision, 0, total) };
}
function harness() {
  const initial = vi.fn(async () => snapshot());
  const page = vi.fn(
    async (_saved: GenerationSnapshot<{ revision: number }>, offset: number) =>
      text("内容", 1, offset),
  );
  const publish = vi.fn();
  const resource = new GenerationResource(
    initial,
    page,
    (metadata) => metadata.revision,
    publish,
  );
  return { resource, initial, page, publish };
}

describe("generation resource reads", () => {
  it("merges notifications received during a read and publishes the latest revision", async () => {
    const { resource, initial, publish } = harness();
    const pending = deferred<GenerationSnapshot<{ revision: number }>>();
    initial
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(snapshot("最新", 5));
    const first = resource.refresh(1);
    await vi.waitFor(() => expect(initial).toHaveBeenCalledOnce());
    const update = resource.refresh(3);
    resource.refresh(5);
    expect(update).toBe(first);
    pending.resolve(snapshot("早期", 1));
    await first;
    expect(initial).toHaveBeenCalledTimes(2);
    expect(resource.state.data?.text.value).toBe("最新");
    expect(
      publish.mock.calls.some(([state]) => state.data?.text.value === "早期"),
    ).toBe(true);
    await resource.refresh(4);
    expect(initial).toHaveBeenCalledTimes(2);
  });

  it("publishes each successful snapshot while notifications continue and converges with one active read", async () => {
    const { resource, initial, publish } = harness();
    const reads = Array.from({ length: 4 }, () =>
      deferred<GenerationSnapshot<{ revision: number }>>(),
    );
    initial.mockImplementation(
      () => reads[initial.mock.calls.length - 1].promise,
    );
    const operation = resource.refresh(1);
    await vi.waitFor(() => expect(initial).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 3; index += 1) {
      expect(resource.refresh(index + 2)).toBe(operation);
      expect(initial).toHaveBeenCalledTimes(index + 1);
      reads[index].resolve(snapshot(`Content ${index + 1}`, index + 1));
      await vi.waitFor(() => expect(initial).toHaveBeenCalledTimes(index + 2));
      expect(resource.state.data?.text.value).toBe(`Content ${index + 1}`);
      expect(resource.state.loading).toBe(true);
    }
    reads[3].resolve(snapshot("Final content", 4));
    await operation;
    expect(resource.state.data?.text.revision).toBe(4);
    expect(resource.state.loading).toBe(false);
    expect(initial).toHaveBeenCalledTimes(4);
    expect(
      publish.mock.calls
        .filter(([state]) => state.data)
        .map(([state]) => state.data.text.revision),
    ).toEqual(expect.arrayContaining([1, 2, 3, 4]));
  });

  it("restores the requested multi-page range for growth, replacement and terminal revisions", async () => {
    const { resource, initial, page, publish } = harness();
    const bodies = new Map([
      [1, "a".repeat(65536)],
      [2, "b".repeat(81920)],
      [3, "c".repeat(57344)],
      [4, "d".repeat(57344)],
      [5, "short"],
      [6, "e".repeat(65536)],
    ]);
    page.mockImplementation(async (saved, offset) => {
      const body = bodies.get(saved.text.revision);
      if (body === undefined) throw new Error("Test revision is unavailable");
      return text(
        body.slice(offset, offset + 16384),
        saved.text.revision,
        offset,
        body.length,
      );
    });
    initial.mockResolvedValue(snapshot("a".repeat(16384), 1, 65536));
    await resource.refresh(1);
    await resource.more();
    await resource.more();
    expect(resource.state.data?.text.next_offset).toBe(49152);
    for (const revision of [2, 3, 4, 5, 6]) {
      const body = bodies.get(revision);
      if (body === undefined) throw new Error("Test revision is unavailable");
      initial.mockResolvedValue({
        ...snapshot(body.slice(0, 16384), revision, body.length),
        metadata: { revision, ...(revision === 4 ? { status: "sent" } : {}) },
      });
      const count = publish.mock.calls.length;
      await resource.refresh(revision);
      const expected = body.slice(0, 49152);
      expect(resource.state.data?.text.value).toBe(expected);
      expect(resource.state.data?.text.revision).toBe(revision);
      expect(resource.state.data?.text.next_offset).toBe(expected.length);
      expect(
        publish.mock.calls
          .slice(count)
          .every(
            ([state]) =>
              state.data.text.revision !== revision ||
              state.data.text.value === expected,
          ),
      ).toBe(true);
      if (revision === 4)
        expect(resource.state.data?.metadata).toMatchObject({ status: "sent" });
    }
    expect(
      page.mock.calls.map(([saved, offset]) => [saved.text.revision, offset]),
    ).toEqual([
      [1, 16384],
      [1, 32768],
      [2, 16384],
      [2, 32768],
      [3, 16384],
      [3, 32768],
      [4, 16384],
      [4, 32768],
      [6, 16384],
      [6, 32768],
    ]);
  });

  it("publishes restored ranges before merging notifications received during continuation reads", async () => {
    const { resource, initial, page } = harness();
    initial.mockResolvedValue(snapshot("first", 1, 20));
    page.mockResolvedValue(text(" page", 1, 5, 20));
    await resource.refresh(1);
    await resource.more();
    const second = deferred<GenerationTextPage>();
    const third = deferred<GenerationTextPage>();
    initial
      .mockResolvedValueOnce(snapshot("other", 2, 25))
      .mockResolvedValue(snapshot("final", 3, 30));
    page.mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const operation = resource.refresh(2);
    await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(2));
    expect(resource.refresh(3)).toBe(operation);
    expect(page).toHaveBeenCalledTimes(2);
    second.resolve(text(" page", 2, 5, 25));
    await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(3));
    expect(resource.state.data?.text.value).toBe("other page");
    expect(resource.state.data?.text.revision).toBe(2);
    third.resolve(text(" page", 3, 5, 30));
    await operation;
    expect(resource.state.data?.text.value).toBe("final page");
    expect(resource.state.data?.text.revision).toBe(3);
    expect(resource.state.error).toBeNull();
  });

  it("restarts range restoration without publishing mixed revisions when a page changes", async () => {
    const { resource, initial, page, publish } = harness();
    initial.mockResolvedValue(snapshot("first", 1, 20));
    page.mockImplementation(async (saved, offset) =>
      text(" page", saved.text.revision, offset, saved.text.total_bytes),
    );
    await resource.refresh(1);
    await resource.more();
    await resource.more();
    initial
      .mockResolvedValueOnce(snapshot("other", 2, 20))
      .mockResolvedValue(snapshot("final", 3, 25));
    page
      .mockResolvedValueOnce(text(" next", 2, 5, 20))
      .mockRejectedValueOnce(
        new BackendError("generation_changed", "Revision changed"),
      )
      .mockResolvedValueOnce(text(" page", 3, 5, 25))
      .mockResolvedValueOnce(text(" text", 3, 10, 25));
    const count = publish.mock.calls.length;
    await resource.refresh(2);
    expect(resource.state.data?.text.value).toBe("final page text");
    expect(resource.state.data?.text.revision).toBe(3);
    expect(
      publish.mock.calls
        .slice(count)
        .every(
          ([state]) =>
            state.data.text.revision === 1 ||
            state.data.text.value === "final page text",
        ),
    ).toBe(true);
    expect(
      page.mock.calls
        .slice(2)
        .map(([saved, offset]) => [saved.text.revision, offset]),
    ).toEqual([
      [2, 5],
      [2, 10],
      [3, 5],
      [3, 10],
    ]);
  });

  it("preserves a pending user continuation across a revision change", async () => {
    const { resource, initial, page } = harness();
    initial
      .mockResolvedValueOnce(snapshot("first", 1, 15))
      .mockResolvedValue(snapshot("other", 2, 15));
    page
      .mockRejectedValueOnce(
        new BackendError("generation_changed", "Revision changed"),
      )
      .mockResolvedValue(text(" page", 2, 5, 15));
    await resource.refresh(1);
    await resource.more();
    expect(resource.state.data?.text.value).toBe("other page");
    expect(resource.state.data?.text.revision).toBe(2);
    expect(
      page.mock.calls.map(([saved, offset]) => [saved.text.revision, offset]),
    ).toEqual([
      [1, 5],
      [2, 5],
    ]);
  });

  it("restores Unicode byte ranges using pages from the same revision", async () => {
    const { resource, initial, page } = harness();
    initial.mockResolvedValue(snapshot("中", 1, 12));
    page.mockImplementation(async (saved, offset) =>
      text("文", saved.text.revision, offset, saved.text.total_bytes),
    );
    await resource.refresh(1);
    await resource.more();
    await resource.more();
    expect(resource.state.data?.text.next_offset).toBe(9);
    initial.mockResolvedValue(snapshot("新", 2, 15));
    await resource.refresh(2);
    expect(resource.state.data?.text.value).toBe("新文文");
    expect(resource.state.data?.text.next_offset).toBe(9);
    expect(
      page.mock.calls.map(([saved, offset]) => [saved.text.revision, offset]),
    ).toEqual([
      [1, 3],
      [1, 6],
      [2, 3],
      [2, 6],
    ]);
  });

  it("keeps the readable range during interrupted revision restoration and ignores late pages", async () => {
    const { resource, initial, page } = harness();
    const interruptedPage = deferred<GenerationTextPage>();
    const restoredPage = deferred<GenerationTextPage>();
    initial.mockResolvedValue(snapshot("first", 1, 20));
    page.mockResolvedValue(text(" page", 1, 5, 20));
    await resource.refresh(1);
    await resource.more();
    initial.mockResolvedValue(snapshot("other", 2, 20));
    page
      .mockReturnValueOnce(interruptedPage.promise)
      .mockReturnValueOnce(restoredPage.promise);
    const interrupted = resource.refresh(2);
    await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(2));
    expect(resource.state.data?.text.value).toBe("first page");
    resource.pause();
    const active = resource.resume();
    await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(3));
    interruptedPage.resolve(text(" late", 2, 5, 20));
    await interrupted;
    expect(resource.state.data?.text.value).toBe("first page");
    expect(resource.state.loading).toBe(true);
    restoredPage.resolve(text(" page", 2, 5, 20));
    await active;
    expect(resource.state.data?.text.value).toBe("other page");
    expect(resource.state.data?.text.next_offset).toBe(10);
    expect(
      page.mock.calls
        .slice(1)
        .map(([saved, offset]) => [saved.text.revision, offset]),
    ).toEqual([
      [2, 5],
      [2, 5],
    ]);
  });

  it.each(["not_a_member", "not_permitted", "permission_denied"])(
    "clears text when restoring the requested range returns %s",
    async (code) => {
      const { resource, initial, page } = harness();
      initial.mockResolvedValue(snapshot("first", 1, 20));
      page.mockResolvedValue(text(" page", 1, 5, 20));
      await resource.refresh(1);
      await resource.more();
      initial.mockResolvedValue(snapshot("other", 2, 20));
      page.mockRejectedValueOnce(new BackendError(code, "Access changed"));
      await resource.refresh(2);
      expect(resource.state.data).toBeNull();
      expect(resource.state.error?.code).toBe(code);
      await resource.refresh(2);
      expect(resource.state.data?.text.value).toBe("other");
      expect(page).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves the readable range and retries revision restoration after a read failure", async () => {
    const { resource, initial, page } = harness();
    initial.mockResolvedValue(snapshot("first", 1, 20));
    page.mockResolvedValue(text(" page", 1, 5, 20));
    await resource.refresh(1);
    await resource.more();
    initial.mockResolvedValue(snapshot("other", 2, 20));
    page.mockRejectedValueOnce(new Error("Read failed"));
    await resource.refresh(2);
    expect(resource.state.data?.text.value).toBe("first page");
    expect(resource.state.error?.message).toBe("Read failed");
    page.mockResolvedValue(text(" page", 2, 5, 20));
    await resource.refresh(2);
    expect(resource.state.data?.text.value).toBe("other page");
    expect(resource.state.error).toBeNull();
  });

  it("appends bounded UTF-8 pages once and preserves completed pages on same revision refresh", async () => {
    const { resource, initial, page } = harness();
    initial.mockResolvedValue(snapshot("中文", 1, 12));
    await resource.refresh();
    const more = resource.more();
    expect(resource.more()).toBe(more);
    await more;
    expect(page).toHaveBeenCalledOnce();
    expect(page.mock.calls[0]).toEqual([snapshot("中文", 1, 12), 6]);
    expect(resource.state.data?.text.value).toBe("中文内容");
    await resource.refresh();
    expect(resource.state.data?.text.next_offset).toBe(12);
    expect(resource.state.data?.text.value).toBe("中文内容");
  });

  it("rereads the current revision when a continuation reports generation_changed", async () => {
    const { resource, initial, page } = harness();
    initial
      .mockResolvedValueOnce(snapshot("中文", 1, 12))
      .mockResolvedValue(snapshot("修订正文", 2));
    page.mockRejectedValueOnce(
      new BackendError("generation_changed", "Revision changed"),
    );
    await resource.refresh();
    await resource.more();
    expect(resource.state.data?.text.value).toBe("修订正文");
    expect(resource.state.data?.text.revision).toBe(2);
    expect(resource.state.error).toBeNull();
  });

  it("recovers a metadata and field revision change during the initial snapshot", async () => {
    const { resource, initial, publish } = harness();
    initial
      .mockRejectedValueOnce(
        new BackendError("generation_changed", "Revision changed"),
      )
      .mockResolvedValue(snapshot("当前完整正文", 3));
    await resource.refresh(2);
    expect(initial).toHaveBeenCalledTimes(2);
    expect(resource.state.data?.text.value).toBe("当前完整正文");
    expect(resource.state.data?.text.revision).toBe(3);
    expect(resource.state.error).toBeNull();
    expect(publish.mock.calls.every(([state]) => state.error === null)).toBe(
      true,
    );
  });

  it.each(["success", "failure"])(
    "isolates a late %s after reconnecting",
    async (outcome) => {
      const { resource, initial } = harness();
      const old = deferred<GenerationSnapshot<{ revision: number }>>();
      const current = deferred<GenerationSnapshot<{ revision: number }>>();
      initial
        .mockResolvedValueOnce(snapshot())
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      await resource.refresh();
      const interrupted = resource.refresh();
      await vi.waitFor(() => expect(initial).toHaveBeenCalledTimes(2));
      resource.pause();
      expect(resource.state.data?.text.value).toBe("中文");
      const active = resource.resume();
      await vi.waitFor(() => expect(initial).toHaveBeenCalledTimes(3));
      if (outcome === "success") old.resolve(snapshot("过期", 1));
      else old.reject(new Error("Interrupted read"));
      await interrupted;
      expect(resource.state.loading).toBe(true);
      current.resolve(snapshot("恢复内容", 2));
      await active;
      expect(resource.state.data?.text.value).toBe("恢复内容");
      expect(resource.state.error).toBeNull();
    },
  );

  it("resumes an interrupted continuation at the saved byte offset", async () => {
    const { resource, initial, page } = harness();
    const pending = deferred<GenerationTextPage>();
    initial.mockResolvedValue(snapshot("中文", 1, 12));
    page
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(text("内容", 1, 6));
    await resource.refresh();
    const interrupted = resource.more();
    await vi.waitFor(() => expect(page).toHaveBeenCalledOnce());
    resource.pause();
    await resource.resume();
    expect(page.mock.calls.map((call) => call[1])).toEqual([6, 6]);
    expect(resource.state.data?.text.value).toBe("中文内容");
    pending.resolve(text("过期", 1, 6));
    await interrupted;
    expect(resource.state.data?.text.value).toBe("中文内容");
  });

  it.each(["not_found", "not_a_member", "permission_denied"])(
    "removes visible content when access returns %s",
    async (code) => {
      const { resource, initial } = harness();
      await resource.refresh();
      initial.mockRejectedValueOnce(new BackendError(code, "Access changed"));
      await resource.refresh();
      expect(resource.state.data).toBeNull();
      expect(resource.state.error?.code).toBe(code);
    },
  );

  it("preserves readable text for a retry after an ordinary read failure", async () => {
    const { resource, initial } = harness();
    await resource.refresh();
    initial.mockRejectedValueOnce(new Error("Read failed"));
    await resource.refresh();
    expect(resource.state.data?.text.value).toBe("中文");
    expect(resource.state.error?.message).toBe("Read failed");
    await resource.refresh();
    expect(resource.state.error).toBeNull();
  });

  it("stops publishing and requesting after disposal", async () => {
    const { resource, initial, publish } = harness();
    const pending = deferred<GenerationSnapshot<{ revision: number }>>();
    initial.mockReturnValueOnce(pending.promise);
    const operation = resource.refresh();
    await vi.waitFor(() => expect(initial).toHaveBeenCalledOnce());
    resource.dispose();
    const calls = publish.mock.calls.length;
    pending.resolve(snapshot());
    await operation;
    await resource.refresh();
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(initial).toHaveBeenCalledOnce();
  });

  it.each([
    { revision: 2 },
    { offset: 1 },
    { next_offset: 3 },
    { next_offset: 5 },
    { total_bytes: 5 },
    { total_bytes: -1 },
    { has_more: true },
  ])("rejects inconsistent byte pages %j", (change) => {
    expect(() =>
      validateGenerationText({ ...text("中文"), ...change }, 1, 0),
    ).toThrow(BackendError);
  });
});
