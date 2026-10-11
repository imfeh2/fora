import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActivityData,
  loadActivity,
} from "@/features/members/activity-data";
import {
  type AgentHistoryRead,
  type AgentHistoryRun,
  backend,
  type HistoryValue,
} from "@/lib/backend";

afterEach(() => vi.restoreAllMocks());

const run: AgentHistoryRun = {
  sequence: 4,
  run_id: "r4",
  status: "completed",
  started_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:01:00Z",
  last_saved_at: "2026-01-01T00:01:00Z",
  window_number: 1,
  window_reset_at: null,
  window_reason: null,
  request_count: 1,
  usage: null,
  error: null,
  legacy: false,
  reminded: [{ discussion_id: 8, message_id: 12 }],
};
const messages = (parts: HistoryValue[], offset = 0, total = parts.length) => ({
  messages: parts,
  offset,
  total,
  has_more: offset + parts.length < total,
  next_offset:
    offset + parts.length < total ? offset + parts.length : undefined,
});
const text = (content: string) => ({
  kind: "response",
  parts: [{ part_kind: "text", content }],
});
const call = (tool_name = "run", args: HistoryValue = { argv: ["pwd"] }) => ({
  kind: "response",
  parts: [{ part_kind: "tool-call", tool_name, tool_call_id: "same-id", args }],
});
const result = (content: HistoryValue, part_kind = "tool-return") => ({
  kind: "request",
  parts: [{ part_kind, tool_name: "run", tool_call_id: "same-id", content }],
});
function read(
  ordinal = 1,
): AgentHistoryRead & { request: NonNullable<AgentHistoryRead["request"]> } {
  const summary = {
    ordinal,
    request_id: `q${ordinal}`,
    run_id: "r4",
    window_number: 1,
    status: "completed",
    started_at: run.started_at,
    completed_at: run.completed_at,
    streaming: false,
    input_length: 0,
    parameters_length: 2,
    settings_length: 2,
    model_length: 2,
    response_length: 100,
    input_count: 0,
    response_count: 1,
    related_count: 1,
    error: null,
  };
  const field = {
    kind: "text" as const,
    source: "parameters" as const,
    request_ordinal: ordinal,
    message_index: 0,
    path: [],
    offset: 0,
    next_offset: 2,
    total_bytes: 2,
    value: "{}",
    has_more: false,
  };
  return {
    agent_id: 2,
    run,
    windows: [],
    windows_has_more: false,
    windows_next_after: null,
    requests: [summary],
    requests_has_more: false,
    requests_next_after: null,
    messages: messages([]),
    missing: [],
    request: {
      summary,
      parameters: field,
      settings: { ...field, source: "settings" },
      model: { ...field, source: "model" },
      input: messages([]),
      response: messages([call()]),
      related: messages([result(`result-${ordinal}`)]),
    },
  };
}
const load = (publish: (value: ActivityData) => void = () => {}) =>
  loadActivity(2, 4, new AbortController().signal, publish);

describe("activity data", () => {
  it.each(["missing", "gap", "prefix", "incomplete"])(
    "reports a %s preceding legacy record with a specific failure",
    async (condition) => {
      const value: AgentHistoryRead = read();
      value.run = { ...run, request_count: 0, legacy: true };
      value.requests = [];
      value.request = undefined;
      const body = JSON.stringify([text("earlier"), text("ending")]);
      value.messages = {
        messages: [{ kind: "legacy", content: body }],
        offset: 0,
        total: body.length,
        has_more: false,
      };
      const previous = { ...value.run, sequence: condition === "gap" ? 2 : 3 };
      vi.spyOn(backend, "agentHistory").mockResolvedValue({
        agent_id: 2,
        runs: condition === "missing" ? [] : [previous],
        windows: [],
        has_before: false,
        next_before: null,
        windows_has_more: false,
        windows_next_after: null,
      });
      vi.spyOn(backend, "agentHistoryRead").mockImplementation(
        async (_agent, sequence) => {
          if (sequence === 4) return value;
          const content = JSON.stringify([
            text(condition === "prefix" ? "different" : "earlier"),
          ]);
          return {
            ...value,
            run: previous,
            missing: condition === "incomplete" ? ["messages"] : [],
            messages: {
              messages: [{ kind: "legacy", content }],
              offset: 0,
              total: content.length,
              has_more: false,
            },
          };
        },
      );
      await expect(load()).rejects.toThrow(
        condition === "missing"
          ? "The preceding saved history is unavailable"
          : condition === "gap"
            ? "The adjacent saved history is unavailable"
            : condition === "prefix"
              ? "Saved legacy history has no matching preceding prefix"
              : "Saved legacy history is incomplete",
      );
    },
  );

  it("reads the first legacy activity in a new context without needing an earlier snapshot", async () => {
    const value: AgentHistoryRead = read();
    value.run = { ...run, request_count: 0, legacy: true };
    value.requests = [];
    value.request = undefined;
    const content = JSON.stringify([text("New context ending")]);
    value.messages = {
      messages: [{ kind: "legacy", content }],
      offset: 0,
      total: content.length,
      has_more: false,
    };
    value.windows = [
      {
        number: 1,
        since_sequence: 4,
        reason: "Initial context",
        reset_at: null,
      },
    ];
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    vi.spyOn(backend, "agentHistory").mockResolvedValue({
      agent_id: 2,
      runs: [],
      windows: [],
      has_before: false,
      next_before: null,
      windows_has_more: false,
      windows_next_after: null,
    });
    expect((await load()).final[0].value.content).toBe("New context ending");
  });

  it("retains an unmatched saved result with an explicit incomplete-history state", async () => {
    const value = read();
    value.request.response = messages([text("Ending")]);
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const data = await load();
    expect(data.actions[0].results[0].value.content).toBe("result-1");
    expect(data.missing).toContain(
      "A saved tool result has no matching action",
    );
    expect(data.final).toEqual([]);
  });

  it("preserves the original location of an image in a complete legacy snapshot", async () => {
    const value: AgentHistoryRead = read();
    const payload = [
      call("view_image", { path: "/image.png" }),
      result({
        kind: "binary",
        data: "YWJj",
        media_type: "image/png",
        identifier: "a9993e",
      }),
      text("Ending"),
    ];
    const content = JSON.stringify(payload);
    value.run = { ...run, request_count: 0, window_number: null, legacy: true };
    value.requests = [];
    value.request = undefined;
    value.messages = {
      messages: [{ kind: "legacy", content }],
      offset: 0,
      total: content.length,
      has_more: false,
    };
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const data = await load();
    expect(data.actions[0].results[0].value.content).toEqual({
      kind: "binary",
      source: "run",
      message_index: 1,
      path: ["parts", 0, "content"],
      media_type: "image/png",
      size: 3,
      identifier: "a9993e",
    });
    expect(data.final[0].value.content).toBe("Ending");
  });

  it("reads every summary and both message channels while retaining request ownership", async () => {
    const all = Array.from(
      { length: 32 },
      (_, index) => read(index + 1).requests[0],
    );
    const readCalls = vi.spyOn(backend, "agentHistoryRead");
    readCalls.mockImplementation(
      async (
        _agent,
        _sequence,
        ordinal,
        _offset,
        _input,
        responseOffset,
        relatedOffset,
        options,
      ) => {
        const value = read(ordinal ?? 1);
        value.run = { ...run, request_count: 32 };
        value.requests =
          options?.requestAfter === 30 ? all.slice(30) : all.slice(0, 30);
        value.requests_has_more = options?.requestAfter !== 30;
        value.requests_next_after = value.requests_has_more ? 30 : null;
        if (ordinal === 32) {
          value.request.response = messages(
            Array.from({ length: responseOffset ? 1 : 100 }, (_, index) =>
              (responseOffset ?? 0) + index === 0
                ? call()
                : text(`text-${(responseOffset ?? 0) + index}`),
            ),
            responseOffset ?? 0,
            101,
          );
          value.request.related = messages(
            Array.from({ length: relatedOffset ? 1 : 100 }, (_, index) =>
              result(`last-${(relatedOffset ?? 0) + index}`),
            ),
            relatedOffset ?? 0,
            101,
          );
        }
        return value;
      },
    );
    const progress: ActivityData[] = [];
    const data = await load((value) => progress.push(value));
    expect(data.complete).toBe(true);
    expect(data.requests).toHaveLength(32);
    expect(data.contents[32].response?.messages).toHaveLength(101);
    expect(data.contents[32].related.messages).toHaveLength(101);
    expect(data.actions).toHaveLength(32);
    expect(data.actions[0].results[0].value.content).toBe("result-1");
    expect(data.actions[1].results[0].value.content).toBe("result-2");
    expect(data.final[data.final.length - 1]?.value.content).toBe("text-100");
    expect(
      progress.slice(0, -1).every((value) => value.final.length === 0),
    ).toBe(true);
    expect(readCalls.mock.calls.some((args) => args[5] === 100)).toBe(true);
    expect(readCalls.mock.calls.some((args) => args[6] === 100)).toBe(true);
  });

  it("retains saved action timestamps and original positions", async () => {
    const value = read();
    value.request.response = messages([
      { ...call(), timestamp: "2026-01-01T00:00:20Z" },
      call("edit", { path: "/workspace/file.md" }),
    ]);
    value.request.related = messages([]);
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const data = await load();
    expect(
      data.actions.map(({ timestamp, ordinal, messageIndex, partIndex }) => ({
        timestamp,
        ordinal,
        messageIndex,
        partIndex,
      })),
    ).toEqual([
      {
        timestamp: "2026-01-01T00:00:20Z",
        ordinal: 1,
        messageIndex: 0,
        partIndex: 0,
      },
      { timestamp: null, ordinal: 1, messageIndex: 1, partIndex: 0 },
    ]);
  });

  it("uses successful sends as replies and keeps failed sends in the action list", async () => {
    const first = read();
    first.run = { ...run, request_count: 3 };
    first.requests = [
      read(1).requests[0],
      read(2).requests[0],
      read(3).requests[0],
    ];
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(
      async (_agent, _sequence, ordinal) => {
        const value = { ...first, request: read(ordinal ?? 1).request };
        if (ordinal === 3) {
          value.request.response = messages([text("ending")]);
          value.request.related = messages([]);
        } else {
          value.request.response = messages([
            call(
              "discussion",
              JSON.stringify({
                action: "send",
                discussion_id: 8,
                body: "sent",
              }),
            ),
          ]);
          value.request.related = messages([
            result(
              ordinal === 2
                ? "failed"
                : { discussion_id: 8, id: 9, created_at: run.started_at },
              ordinal === 2 ? "retry-prompt" : "tool-return",
            ),
          ]);
        }
        return value;
      },
    );
    const data = await load();
    expect(data.actions[0].sent).toEqual({
      discussion_id: 8,
      message_id: 9,
      created_at: run.started_at,
    });
    expect(data.actions[1].sent).toBeNull();
    expect(data.actions[1].results[0].value.part_kind).toBe("retry-prompt");
    expect(data.final).toEqual([]);
    expect(data.notes.some((part) => part.value.content === "ending")).toBe(
      false,
    );
  });

  it("completes paged JSON arguments before deciding send identity", async () => {
    const value = read();
    value.request.response = messages([
      call("discussion", {
        kind: "text",
        source: "response",
        request_ordinal: 1,
        message_index: 0,
        path: ["parts", 0, "args"],
        offset: 0,
        next_offset: 10,
        total_bytes: 26,
        value: '{"action":',
        has_more: true,
      }),
    ]);
    value.request.related = messages([
      result({ discussion_id: 8, id: 9, created_at: run.started_at }),
    ]);
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const textRead = vi.spyOn(backend, "agentHistoryText").mockResolvedValue({
      offset: 10,
      next_offset: 26,
      total_bytes: 26,
      value: '"send"}',
      has_more: false,
    });
    const data = await load();
    expect(data.actions[0].args).toEqual({ action: "send" });
    expect(data.actions[0].sent?.message_id).toBe(9);
    expect(textRead).toHaveBeenCalledOnce();
    expect(textRead.mock.calls[0][2].offset).toBe(10);
  });

  it("does not publish late results after cancellation", async () => {
    const abort = new AbortController();
    let resolve!: (value: AgentHistoryRead) => void;
    vi.spyOn(backend, "agentHistoryRead").mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const publish = vi.fn();
    const operation = loadActivity(2, 4, abort.signal, publish);
    abort.abort();
    resolve(read());
    await expect(operation).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("retains final model text only after a completed full read without successful sends", async () => {
    const value = read();
    value.request.response = messages([text("work record")]);
    value.request.related = messages([]);
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    expect((await load()).final[0].value.content).toBe("work record");
    value.run = { ...run, status: "running" };
    expect((await load()).final).toEqual([]);
    value.run = { ...run, status: "failed" };
    expect((await load()).final).toEqual([]);
    value.run = run;
    value.missing = ["response"];
    expect((await load()).final).toEqual([]);
  });

  it("reads complete legacy pages and removes a saved preceding common prefix", async () => {
    const prefix = [text("earlier")];
    const full = JSON.stringify([...prefix, text("中文 ending")]);
    const value: AgentHistoryRead = read();
    value.request = undefined;
    value.run = { ...run, request_count: 0, legacy: true };
    value.requests = [];
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(
      async (_agent, sequence, _ordinal, offset) => ({
        ...value,
        run: { ...value.run, sequence },
        messages:
          sequence === 3
            ? {
                messages: [{ kind: "legacy", content: JSON.stringify(prefix) }],
                offset: 0,
                total: JSON.stringify(prefix).length,
                has_more: false,
              }
            : {
                messages: [
                  {
                    kind: "legacy",
                    content: offset ? full.slice(12) : full.slice(0, 12),
                  },
                ],
                offset: offset ?? 0,
                total: full.length,
                has_more: !offset,
                next_offset: offset ? undefined : 12,
              },
      }),
    );
    vi.spyOn(backend, "agentHistory").mockResolvedValue({
      agent_id: 2,
      runs: [{ ...value.run, sequence: 3 }],
      windows: [],
      has_before: false,
      next_before: null,
      windows_has_more: false,
      windows_next_after: null,
    });
    const data = await load();
    expect(data.legacyStart).toBe(1);
    expect(data.notes.some((part) => part.value.content === "earlier")).toBe(
      false,
    );
    expect(data.final[0].value.content).toBe("中文 ending");
  });

  it.each(["arguments", "summary", "message"])(
    "reports invalid %s without producing fabricated content",
    async (source) => {
      const value = read();
      if (source === "arguments")
        value.request.response = messages([call("run", "{invalid")]);
      if (source === "summary") {
        value.requests_has_more = true;
        value.requests_next_after = null;
      }
      if (source === "message") {
        value.request.related.has_more = true;
        value.request.related.next_offset = 0;
      }
      vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
      await expect(load()).rejects.toThrow();
    },
  );
});
