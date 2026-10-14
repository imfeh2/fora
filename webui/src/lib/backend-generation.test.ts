import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, type Frame, type Socket } from "@/lib/backend";

const key = {
  agent_id: 2,
  sequence: 4,
  ordinal: 3,
  part_index: 0,
  request_id: "request-3",
  run_id: "run-4",
};
const calls = [
  {
    method: "discussion.previews",
    params: { discussion_id: 8, before: ["2026-10-11", "preview"], limit: 5 },
    invoke: (backend: Backend) =>
      backend.discussionPreviews(8, ["2026-10-11", "preview"], 5),
  },
  {
    method: "discussion.preview",
    params: { discussion_id: 8, preview_id: "preview" },
    invoke: (backend: Backend) => backend.discussionPreview(8, "preview"),
  },
  {
    method: "discussion.preview.text",
    params: {
      discussion_id: 8,
      preview_id: "preview",
      revision: 7,
      offset: 6,
      limit: 16384,
    },
    invoke: (backend: Backend) =>
      backend.discussionPreviewText(8, "preview", 7, 6),
  },
  {
    method: "agent.generation.parts",
    params: { agent_id: 2, sequence: 4, ordinal: 3, after: 0, limit: 5 },
    invoke: (backend: Backend) => backend.agentGenerationParts(2, 4, 3, 0, 5),
  },
  {
    method: "agent.generation.text",
    params: {
      agent_id: 2,
      sequence: 4,
      ordinal: 3,
      part_index: 0,
      request_id: "request-3",
      revision: 7,
      field: "content",
      offset: 6,
      limit: 16384,
    },
    invoke: (backend: Backend) =>
      backend.agentGenerationText(key, 7, "content", 6),
  },
];

function harness() {
  const sent: { id: number; method: string; params: unknown }[] = [];
  const socket: Socket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => sent.push(JSON.parse(data)),
    close: () => {},
  };
  const backend = new Backend(
    () => ({ url: "ws://localhost/ws?token=test" }),
    () => socket,
  );
  const connecting = backend.connect();
  socket.onopen?.(new Event("open"));
  const reply = (frame: Frame) =>
    socket.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  return { backend, socket, sent, connecting, reply };
}

afterEach(() => vi.useRealTimers());

describe("generation resource transport", () => {
  it.each(calls)(
    "reads $method with its exact resource identity",
    async (call) => {
      const { backend, sent, connecting, reply } = harness();
      await connecting;
      const pending = call.invoke(backend);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({
        method: call.method,
        params: call.params,
      });
      const result = { revision: 7, value: "中文内容" };
      reply({ type: "response", id: sent[0].id, result });
      expect(await pending).toEqual(result);
    },
  );

  it.each(calls)(
    "keeps $method read failures definite on disconnect",
    async (call) => {
      const { backend, socket, sent, connecting } = harness();
      await connecting;
      const pending = call.invoke(backend);
      const failure = expect(pending).rejects.toMatchObject({
        code: "disconnected",
        transport: true,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      socket.onclose?.({
        code: 1006,
        reason: "",
        wasClean: false,
      } as CloseEvent);
      await failure;
    },
  );

  it.each(calls)("reports a read timeout for $method", async (call) => {
    vi.useFakeTimers();
    const { backend, connecting } = harness();
    await connecting;
    const pending = call.invoke(backend);
    const failure = expect(pending).rejects.toMatchObject({
      code: "timeout",
      operation: call.method,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
  });

  it.each(["json", "content", "args"] as const)(
    "reads the selected %s field from the same request and revision",
    async (field) => {
      const { backend, sent, connecting, reply } = harness();
      await connecting;
      const pending = backend.agentGenerationText(key, 7, field);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].params).toMatchObject({
        request_id: key.request_id,
        part_index: 0,
        revision: 7,
        field,
        offset: 0,
      });
      reply({ type: "response", id: sent[0].id, result: {} });
      await pending;
    },
  );
});
