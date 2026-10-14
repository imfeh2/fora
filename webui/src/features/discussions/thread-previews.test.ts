import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "@/features/discussions/thread-data";
import {
  combineThreadUnits,
  DiscussionPreviewReader,
} from "@/features/discussions/thread-previews";
import {
  BackendError,
  type BackendEvent,
  backend,
  type DiscussionPreview,
  type DiscussionPreviewRead,
} from "@/lib/backend";

const listeners = new Set<(event: BackendEvent) => void>();
let reader: DiscussionPreviewReader;
function metadata(revision = 1, id = "preview"): DiscussionPreview {
  return {
    preview_id: id,
    key: {
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      part_index: 0,
      request_id: id,
      run_id: "run",
    },
    discussion_id: 8,
    revision,
    status: "generating",
    error: null,
    message_id: null,
    created_at: "2026-10-11T09:00:00Z",
    updated_at: "2026-10-11T09:00:00Z",
  };
}
function read(preview = metadata(), body = "中文"): DiscussionPreviewRead {
  const bytes = new TextEncoder().encode(body).length;
  return {
    preview,
    body: {
      revision: preview.revision,
      offset: 0,
      next_offset: bytes,
      total_bytes: bytes,
      value: body,
      has_more: false,
    },
  };
}
function directory(
  previews = [metadata()],
  before: [string, string] | null = null,
) {
  return {
    discussion_id: 8,
    previews,
    has_more: before !== null,
    next_before: before,
  };
}
function event(event: BackendEvent) {
  for (const listener of listeners) listener(event);
}
function message(id = 14): ThreadMessage {
  return {
    id,
    sender_id: 2,
    sender_name: "文档助手",
    body: "正文",
    mentions: [],
    attachments: [],
    created_at: "2026-10-11T09:01:00Z",
    pending: true,
    acknowledged: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  reader = new DiscussionPreviewReader(8, vi.fn());
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  vi.spyOn(backend, "discussionPreviews").mockResolvedValue(directory());
  vi.spyOn(backend, "discussionPreview").mockResolvedValue(read());
});
afterEach(() => {
  reader.dispose();
  listeners.clear();
  vi.restoreAllMocks();
});

describe("Discussion preview reads", () => {
  it("subscribes before reading and keeps independent parallel resources", async () => {
    vi.mocked(backend.discussionPreviews).mockImplementation(async () => {
      expect(listeners.size).toBe(1);
      return directory([metadata(1, "one"), metadata(1, "two")]);
    });
    vi.mocked(backend.discussionPreview).mockImplementation(
      async (_discussion, id) => read(metadata(1, id), id),
    );
    await reader.start();
    await vi.waitFor(() =>
      expect(
        Object.values(reader.state.resources).filter((state) => state.data),
      ).toHaveLength(2),
    );
    expect(
      combineThreadUnits([], reader.state).map((unit) => unit.key),
    ).toEqual(["preview:one", "preview:two"]);
  });

  it("keeps a stable reading unit while a mapped message arrives ahead of its resource update", async () => {
    await reader.start();
    await vi.waitFor(() =>
      expect(reader.state.resources.preview?.data).toBeTruthy(),
    );
    const pending = deferred<DiscussionPreviewRead>();
    vi.mocked(backend.discussionPreview).mockReturnValueOnce(pending.promise);
    const first = combineThreadUnits([], reader.state)[0];
    event({
      type: "message.created",
      discussion_id: 8,
      id: 14,
      preview_id: "preview",
      revision: 2,
    });
    const units = combineThreadUnits([message()], reader.state);
    expect(units).toHaveLength(1);
    expect(units[0].key).toBe(first.key);
    expect(units[0].timestamp).toBe(first.timestamp);
    expect(units[0].message?.pending).toBe(true);
    pending.resolve(read({ ...metadata(2), status: "sent", message_id: 14 }));
    await vi.waitFor(() =>
      expect(reader.state.metadata.preview.status).toBe("sent"),
    );
    expect(combineThreadUnits([message()], reader.state)).toHaveLength(1);
  });

  it("keeps the reading unit and requested text range when a terminal revision arrives", async () => {
    let revision = 1;
    vi.mocked(backend.discussionPreview).mockImplementation(async () => ({
      preview: {
        ...metadata(revision),
        ...(revision === 2
          ? { status: "failed" as const, error: "Tool execution failed" }
          : {}),
      },
      body: {
        revision,
        offset: 0,
        next_offset: 5,
        total_bytes: 20,
        value: revision === 1 ? "first" : "other",
        has_more: true,
      },
    }));
    const page = vi
      .spyOn(backend, "discussionPreviewText")
      .mockImplementation(
        async (_discussion, _id, currentRevision, offset = 0) => ({
          revision: currentRevision,
          offset,
          next_offset: offset + 5,
          total_bytes: 20,
          value: " page",
          has_more: offset + 5 < 20,
        }),
      );
    await reader.start();
    await vi.waitFor(() =>
      expect(reader.state.resources.preview?.data).toBeTruthy(),
    );
    await reader.more("preview");
    await reader.more("preview");
    const original = combineThreadUnits([], reader.state)[0];
    expect(original.preview?.data?.text.value).toBe("first page page");
    revision = 2;
    event({
      type: "discussion.preview",
      discussion_id: 8,
      preview_id: "preview",
      revision,
    });
    await vi.waitFor(() =>
      expect(reader.state.resources.preview.data?.text.revision).toBe(2),
    );
    const current = combineThreadUnits([], reader.state)[0];
    expect(current.key).toBe(original.key);
    expect(current.timestamp).toBe(original.timestamp);
    expect(current.preview?.data?.text.value).toBe("other page page");
    expect(current.preview?.data?.metadata.error).toBe("Tool execution failed");
    expect(page.mock.calls.map((call) => call.slice(2, 4))).toEqual([
      [1, 5],
      [1, 10],
      [2, 5],
      [2, 10],
    ]);
  });

  it("recovers a committed mapping from the directory without duplicating its message", async () => {
    vi.mocked(backend.discussionPreviews).mockResolvedValue(
      directory([{ ...metadata(2), status: "sent", message_id: 14 }]),
    );
    await reader.start();
    expect(reader.state.aliases[14]).toBe("preview");
    expect(backend.discussionPreview).not.toHaveBeenCalled();
    const units = combineThreadUnits([message()], reader.state);
    expect(units).toHaveLength(1);
    expect(units[0].key).toBe("preview:preview");
  });

  it("removes a resource when its target changes and ignores unrelated Discussions", async () => {
    await reader.start();
    await vi.waitFor(() =>
      expect(reader.state.resources.preview?.data).toBeTruthy(),
    );
    event({
      type: "discussion.preview",
      discussion_id: 9,
      preview_id: "preview",
      revision: 2,
    });
    expect(backend.discussionPreview).toHaveBeenCalledOnce();
    vi.mocked(backend.discussionPreview).mockRejectedValueOnce(
      new BackendError("not_found", "Target changed"),
    );
    event({
      type: "discussion.preview",
      discussion_id: 8,
      preview_id: "preview",
      revision: 2,
    });
    await vi.waitFor(() =>
      expect(reader.state.resources.preview.data).toBeNull(),
    );
    expect(combineThreadUnits([], reader.state)).toEqual([]);
  });

  it.each(["discussion.updated", "member.deleted"])(
    "refreshes permissions for a known resource on %s",
    async (type) => {
      await reader.start();
      await vi.waitFor(() =>
        expect(reader.state.resources.preview?.data).toBeTruthy(),
      );
      vi.mocked(backend.discussionPreviews).mockResolvedValue(directory([]));
      vi.mocked(backend.discussionPreview).mockRejectedValueOnce(
        new BackendError("not_found", "Sender was removed"),
      );
      event({ type, id: type === "member.deleted" ? 2 : 8 });
      await vi.waitFor(() =>
        expect(reader.state.resources.preview.data).toBeNull(),
      );
      expect(combineThreadUnits([], reader.state)).toEqual([]);
    },
  );

  it("uses the stable earlier cursor and preserves the oldest loaded boundary on refresh", async () => {
    const before: [string, string] = ["2026-10-11T09:00:00Z", "preview"];
    vi.mocked(backend.discussionPreviews)
      .mockResolvedValueOnce(directory([], before))
      .mockResolvedValueOnce(directory([]))
      .mockResolvedValue(directory([], before));
    await reader.start();
    await reader.earlier();
    expect(vi.mocked(backend.discussionPreviews).mock.calls[1]).toEqual([
      8,
      before,
      50,
    ]);
    expect(reader.state.before).toBeNull();
    await reader.refresh();
    expect(reader.state.before).toBeNull();
  });

  it("ignores the old directory finally while a recovered read is active", async () => {
    const old = deferred<ReturnType<typeof directory>>();
    const current = deferred<ReturnType<typeof directory>>();
    vi.mocked(backend.discussionPreviews)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const first = reader.start();
    await vi.waitFor(() =>
      expect(backend.discussionPreviews).toHaveBeenCalledOnce(),
    );
    event({ type: "connection.closed" });
    event({ type: "connection.restored" });
    await vi.waitFor(() =>
      expect(backend.discussionPreviews).toHaveBeenCalledTimes(2),
    );
    old.resolve(directory([]));
    await first;
    expect(reader.state.loading).toBe(true);
    current.resolve(directory([]));
    await vi.waitFor(() => expect(reader.state.loading).toBe(false));
  });
});
