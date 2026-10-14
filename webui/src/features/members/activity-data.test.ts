import { afterEach, describe, expect, it, vi } from "vitest";
import { composeContext } from "@/features/members/activity-context";
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
const view = (data: ActivityData) => composeContext(2, [data]);
const actions = (data: ActivityData) =>
  view(data).entries.flatMap((entry) => (entry.action ? [entry.action] : []));
const ending = (data: ActivityData) =>
  view(data).entries.filter((entry) => entry.workRecord);

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
      const current = await load();
      const prior =
        condition === "missing"
          ? []
          : [
              await loadActivity(
                2,
                previous.sequence,
                new AbortController().signal,
                () => {},
              ),
            ];
      const context = composeContext(2, [...prior, current]);
      expect(
        context.entries.some((entry) => entry.resolved.content === "ending"),
      ).toBe(true);
      expect(context.missing).toContain(
        condition === "prefix"
          ? "Saved legacy history has no matching preceding prefix"
          : condition === "incomplete"
            ? "messages"
            : "The preceding saved history has not been loaded",
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
    expect(ending(await load())[0].value.content).toBe("New context ending");
  });

  it("retains an unmatched saved result with an explicit incomplete-history state", async () => {
    const value = read();
    value.request.response = messages([text("Ending")]);
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const data = await load();
    expect(
      view(data).entries.some((entry) => entry.value.content === "result-1"),
    ).toBe(true);
    expect(view(data).missing).toContain(
      "A saved tool result has no matching action",
    );
    expect(ending(data).map((part) => part.value.content)).toEqual(["Ending"]);
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
    expect(actions(data)[0].results[0].value.content).toEqual({
      kind: "binary",
      source: "run",
      message_index: 1,
      path: ["parts", 0, "content"],
      media_type: "image/png",
      size: 3,
      identifier: "a9993e",
    });
    expect(ending(data)[0].value.content).toBe("Ending");
  });

  it("reads every summary and all three message channels while retaining request ownership", async () => {
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
        inputOffset,
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
          value.request.input = messages(
            Array.from({ length: inputOffset ? 1 : 100 }, (_, index) => ({
              kind: "request",
              parts: [
                {
                  part_kind: "user-prompt",
                  content: `input-${(inputOffset ?? 0) + index}`,
                },
              ],
            })),
            inputOffset ?? 0,
            101,
          );
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
    expect(data.contents[32].request.input.messages).toHaveLength(101);
    expect(data.contents[32].values.input).toHaveLength(101);
    expect(data.contents[32].request.response?.messages).toHaveLength(101);
    expect(data.contents[32].request.related.messages).toHaveLength(101);
    expect(actions(data)).toHaveLength(32);
    expect(actions(data)[0].results[0].value.content).toBe("result-1");
    expect(actions(data)[1].results[0].value.content).toBe("result-2");
    expect(ending(data)[ending(data).length - 1]?.value.content).toBe(
      "text-100",
    );
    expect(
      progress.every((value) => {
        composeContext(2, [value]);
        return true;
      }),
    ).toBe(true);
    expect(readCalls.mock.calls.some((args) => args[4] === 100)).toBe(true);
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
      actions(data).map(({ timestamp, ordinal, messageIndex, partIndex }) => ({
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
      { timestamp: run.started_at, ordinal: 1, messageIndex: 1, partIndex: 0 },
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
    expect(actions(data)[0].sent).toEqual({
      discussion_id: 8,
      message_id: 9,
      created_at: run.started_at,
    });
    expect(actions(data)[1].sent).toBeNull();
    expect(actions(data)[1].results[0].value.part_kind).toBe("retry-prompt");
    expect(ending(data).map((part) => part.value.content)).toEqual(["ending"]);
    expect(
      view(data).entries.filter((entry) => entry.resolved.content === "ending"),
    ).toHaveLength(1);
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
    expect(actions(data)[0].args).toEqual({ action: "send" });
    expect(actions(data)[0].sent).toBeNull();
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

  it("retains saved final model text with running, failed and incomplete records", async () => {
    const value = read();
    value.request.response = messages([text("work record")]);
    value.request.related = messages([]);
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    expect(ending(await load())[0].value.content).toBe("work record");
    value.run = { ...run, status: "running" };
    expect(ending(await load()).map((part) => part.value.content)).toEqual([
      "work record",
    ]);
    value.run = { ...run, status: "failed" };
    expect(ending(await load()).map((part) => part.value.content)).toEqual([
      "work record",
    ]);
    value.run = run;
    value.missing = ["response"];
    const incomplete = await load();
    expect(ending(incomplete).map((part) => part.value.content)).toEqual([
      "work record",
    ]);
    expect(incomplete.missing).toContain("response");
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
    const previous = await loadActivity(
      2,
      3,
      new AbortController().signal,
      () => {},
    );
    const context = composeContext(2, [previous, data]);
    expect(
      context.entries.filter((entry) => entry.resolved.content === "earlier"),
    ).toHaveLength(1);
    expect(
      context.entries.some((entry) => entry.resolved.content === "中文 ending"),
    ).toBe(true);
  });

  it("preserves malformed saved arguments as their complete original text", async () => {
    const value = read();
    value.request.response = messages([call("run", "{invalid")]);
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const data = await load();
    expect(data.complete).toBe(true);
    expect(actions(data)[0].args).toBe("{invalid");
    expect(actions(data)[0].sent).toBeNull();
  });

  it.each(["summary", "message"])(
    "reports invalid %s without producing fabricated content",
    async (source) => {
      const value = read();
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
