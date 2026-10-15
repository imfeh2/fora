import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeContext,
  contextImageKey,
  contextLocationKey,
} from "@/features/members/activity-context";
import {
  type ActivityData,
  loadActivity,
  mergeActivityData,
} from "@/features/members/activity-data";
import {
  type AgentHistoryRead,
  backend,
  type GenerationPart,
  type HistoryBinary,
  type HistoryValue,
} from "@/lib/backend";

const at = "2026-10-08T09:15:00Z";
const prompt =
  "You are 文档助手 (Member 2). These Messages mention you and are waiting for you:\n\n- [previously reminded] Discussion 8 (网站说明), Message 12 from 林小雨\n\nUse discussion action=read to see what they say and the surrounding context, then decide what to do. Some of these were already shown to you and are still waiting. Only discussion ack marks one as handled.";
const user = (content: HistoryValue, runId = "sdk-current") => ({
  kind: "request",
  run_id: runId,
  timestamp: at,
  instructions: null,
  metadata: null,
  parts: [{ part_kind: "user-prompt", content, timestamp: at }],
});
const marker = (
  parts: {
    part_index: number;
    kind: string;
    source_id: string;
    sequence?: number;
  }[],
  sequence = 4,
) => ({
  fora: {
    context_sources: {
      version: 1,
      metadata_was_none: true,
      fora_was_missing: true,
      parts: parts.map((source) => ({ agent_id: 2, sequence, ...source })),
    },
  },
});
const response = (parts: HistoryValue[], runId = "sdk-current") => ({
  kind: "response",
  run_id: runId,
  timestamp: at,
  metadata: null,
  parts,
});
const page = (messages: HistoryValue[]) => ({
  offset: 0,
  total: messages.length,
  has_more: false,
  messages,
});
function record(ordinal = 1, sequence = 4): AgentHistoryRead {
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
  const summary = {
    ordinal,
    request_id: `request-${ordinal}`,
    run_id: `fora-${sequence}`,
    window_number: 1,
    status: "completed",
    started_at: at,
    completed_at: at,
    streaming: false,
    input_length: 0,
    parameters_length: 2,
    settings_length: 2,
    model_length: 2,
    response_length: 0,
    input_count: 2,
    response_count: 1,
    related_count: 0,
    error: null,
  };
  return {
    agent_id: 2,
    run: {
      sequence,
      run_id: `fora-${sequence}`,
      status: "completed",
      started_at: at,
      completed_at: at,
      last_saved_at: at,
      window_number: 1,
      window_reset_at: null,
      window_reason: null,
      request_count: 1,
      usage: null,
      error: null,
      legacy: false,
      reminded: [{ discussion_id: 8, message_id: 12 }],
    },
    windows: [],
    windows_has_more: false,
    windows_next_after: null,
    requests: [summary],
    requests_has_more: false,
    requests_next_after: null,
    messages: page([]),
    missing: [],
    request: {
      summary,
      parameters: field,
      settings: { ...field, source: "settings" },
      model: { ...field, source: "model" },
      input: page([
        {
          kind: "request",
          run_id: null,
          metadata: marker(
            [
              {
                part_index: 0,
                kind: "session_context",
                source_id: `session-${sequence}`,
              },
              {
                part_index: 1,
                kind: "reminder",
                source_id: `reminder-${sequence}`,
              },
            ],
            sequence,
          ),
          parts: [
            {
              part_kind: "user-prompt",
              content:
                "Your MEMORY.md:\n网站资料\n\nEnvironment\n这行属于原记忆\n\nCommands run on linux",
              timestamp: at,
            },
            { part_kind: "user-prompt", content: prompt, timestamp: at },
          ],
        },
      ]),
      response: page([
        response([{ part_kind: "text", content: "工作记录", id: null }]),
      ]),
      related: page([]),
    },
  };
}
async function read(records: AgentHistoryRead[]) {
  vi.spyOn(backend, "agentHistoryRead").mockImplementation(
    async (_agent, sequence, ordinal) => {
      const value = records.find(
        (value) =>
          value.run.sequence === sequence &&
          value.request?.summary.ordinal ===
            (ordinal ?? records[0].request?.summary.ordinal),
      );
      if (!value) throw new Error("Missing test request");
      return value;
    },
  );
  return loadActivity(
    2,
    records[0].run.sequence,
    new AbortController().signal,
    () => {},
  );
}
afterEach(() => vi.restoreAllMocks());

function cancelledRecord(
  ordinal: number,
  started: string | null,
  hasResult: boolean,
): AgentHistoryRead {
  const value = record(ordinal);
  const request = value.request;
  if (!request) throw new Error("Missing request");
  const content =
    "The Turn ended without a confirmed result for this call. It may have executed; check the outcome before retrying.";
  request.response = page([
    response([
      {
        part_kind: "tool-call",
        tool_name: "run",
        tool_call_id: "cancelled",
        args: { argv: ["pwd"] },
      },
      {
        part_kind: "tool-call",
        tool_name: "run",
        tool_call_id: "adjacent",
        args: { argv: ["pwd"] },
      },
      {
        part_kind: "tool-call",
        tool_name: "view_image",
        tool_call_id: "image",
        args: { path: "配图.png" },
      },
    ]),
  ]);
  request.related = page([
    {
      kind: "request",
      metadata: {
        fora: {
          request_id: request.summary.request_id,
          request_ordinal: ordinal,
          tool_observations: [
            {
              request_ordinal: ordinal,
              part_index: 0,
              tool_call_id: "cancelled",
              tool_name: "run",
              status: "cancelled",
              started_at: started,
              completed_at: at,
              has_result: hasResult,
              content_version: `cancelled-${ordinal}`,
              result_positions: hasResult ? [[0, 0]] : [],
            },
            {
              request_ordinal: ordinal,
              part_index: 1,
              tool_call_id: "adjacent",
              tool_name: "run",
              status: "cancelled",
              started_at: at,
              completed_at: at,
              has_result: true,
              content_version: `adjacent-${ordinal}`,
              result_positions: [[0, 1]],
            },
            {
              request_ordinal: ordinal,
              part_index: 2,
              tool_call_id: "image",
              tool_name: "view_image",
              status: "completed",
              started_at: at,
              completed_at: at,
              has_result: true,
              content_version: `image-${ordinal}`,
              result_positions: [
                [0, 2],
                [0, 3],
              ],
            },
          ],
        },
      },
      parts: [
        {
          part_kind: "tool-return",
          tool_name: "run",
          tool_call_id: "cancelled",
          outcome: "interrupted",
          content,
          timestamp: at,
        },
        {
          part_kind: "tool-return",
          tool_name: "run",
          tool_call_id: "adjacent",
          outcome: "interrupted",
          content,
          timestamp: at,
        },
        {
          part_kind: "tool-return",
          tool_name: "view_image",
          tool_call_id: "image",
          outcome: "success",
          content: "Image ready",
          timestamp: at,
        },
        {
          part_kind: "user-prompt",
          content: [
            {
              kind: "binary",
              source: "related",
              request_ordinal: ordinal,
              message_index: 0,
              path: ["parts", 3, "content", 0],
              media_type: "image/png",
              size: 3,
              identifier: "same",
            },
          ],
          timestamp: at,
        },
      ],
    },
  ]);
  return value;
}

describe("saved observation isolation", () => {
  const observations = (value: AgentHistoryRead) => {
    const message = value.request?.related.messages[0] as Record<
      string,
      HistoryValue
    >;
    const metadata = message.metadata as Record<string, HistoryValue>;
    const fora = metadata.fora as Record<string, HistoryValue>;
    return fora.tool_observations as Record<string, HistoryValue>[];
  };

  it.each([
    ["request_ordinal", 9],
    ["tool_call_id", "other-call"],
    ["tool_name", "other-tool"],
    ["status", "unknown"],
    ["started_at", 4],
    ["completed_at", false],
    ["has_result", "false"],
  ] as const)(
    "isolates invalid observation field %s without changing original results",
    async (field, invalid) => {
      const value = cancelledRecord(1, null, false);
      observations(value)[0][field] = invalid;
      const original = structuredClone(value);
      const data = await read([value]);
      const context = composeContext(2, [data]);
      const action = context.entries.find(
        (entry) => entry.value.tool_call_id === "cancelled" && entry.action,
      )?.action;
      expect(
        context.diagnostics.some(
          (item) => item.location.path[item.location.path.length - 1] === field,
        ),
      ).toBe(true);
      expect(action?.observationError).toBeDefined();
      expect(action?.lifecycle).toBeUndefined();
      expect(action?.results[0].value.content).toContain(
        "without a confirmed result",
      );
      expect(
        context.entries.find(
          (entry) => entry.value.tool_call_id === "adjacent" && entry.action,
        )?.action?.lifecycle?.status,
      ).toBe("cancelled");
      expect(
        context.entries.find(
          (entry) => entry.value.tool_call_id === "image" && entry.action,
        )?.action?.results,
      ).toHaveLength(2);
      expect(value).toEqual(original);
    },
  );

  it("keeps historical input calls separate from current response observations at the same part index", async () => {
    const value = cancelledRecord(1, null, false);
    value.request!.input.messages.push(
      response([
        {
          part_kind: "tool-call",
          tool_call_id: "historical",
          tool_name: "read_file",
          args: { path: "guide.md" },
        },
      ]),
      {
        kind: "request",
        parts: [
          {
            part_kind: "tool-return",
            tool_call_id: "historical",
            tool_name: "read_file",
            content: "Historical result",
            outcome: "success",
          },
        ],
      },
    );
    value.request!.input.total = value.request!.input.messages.length;
    const data = await read([value]);
    const context = composeContext(2, [data]);
    expect(context.diagnostics).toEqual([]);
    const historical = context.entries.find(
      (entry) => entry.value.tool_call_id === "historical" && entry.action,
    )?.action;
    expect(historical?.results[0].value.content).toBe("Historical result");
    expect(historical?.lifecycle?.status).toBe("completed");
    expect(historical?.lifecycle?.completed_at).toBeNull();
    expect(
      context.entries.find(
        (entry) => entry.source === "response" && entry.partIndex === 0,
      )?.action?.lifecycle?.status,
    ).toBe("cancelled");
  });

  it("uses verified original response references when a predecessor is loaded", async () => {
    const earlier = cancelledRecord(1, null, false);
    const later = cancelledRecord(2, at, true);
    expect(earlier.request?.response?.messages).toHaveLength(1);
    later.request!.input = page([
      ...earlier.request!.input.messages,
      ...earlier.request!.response!.messages,
      ...earlier.request!.related.messages,
    ]);
    const laterData = await read([later]);
    const identities = new Map<string, string>();
    const before = composeContext(2, [laterData], {}, identities);
    expect(before.diagnostics).toEqual([]);
    const historical = before.entries.find(
      (entry) =>
        entry.source === "input" &&
        entry.action?.value.tool_call_id === "cancelled",
    );
    expect(historical?.action?.lifecycle?.status).toBe("cancelled");
    expect(historical?.action?.lifecycle?.has_result).toBe(true);
    const earlierData = await read([earlier]);
    const combined = {
      ...laterData,
      requests: [...earlierData.requests, ...laterData.requests],
      contents: { ...earlierData.contents, ...laterData.contents },
    };
    const original = structuredClone(combined);
    for (const [ordinal, snapshot] of Object.entries(combined.contents))
      original.contents[Number(ordinal)].readId = snapshot.readId;
    const after = composeContext(2, [combined], {}, identities);
    expect(after.diagnostics).toEqual([]);
    const calls = after.entries.filter(
      (entry) => entry.action?.value.tool_call_id === "cancelled",
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(calls[0].key).toBe(historical?.key);
    expect(
      calls[0].references.some(
        (reference) => reference.ordinal === 2 && reference.source === "input",
      ),
    ).toBe(true);
    expect(calls[0].action?.lifecycle).toMatchObject({
      status: "cancelled",
      has_result: false,
      started_at: null,
    });
    expect(calls[0].action?.results).toEqual([]);
    expect(calls[1].action?.lifecycle).toMatchObject({
      status: "cancelled",
      has_result: true,
      started_at: at,
    });
    expect(calls[1].action?.results).toHaveLength(1);
    expect(calls[1].action?.results[0].ordinal).toBe(2);
    expect(combined).toEqual(original);
  });

  it.each([-1, 99, "0", null])(
    "diagnoses an unassigned observation index %s",
    async (index) => {
      const value = cancelledRecord(1, null, false);
      observations(value)[0].part_index = index;
      const data = await read([value]);
      const context = composeContext(2, [data]);
      expect(context.diagnostics).toHaveLength(1);
      expect(context.diagnostics[0].location.path).toEqual([
        "metadata",
        "fora",
        "tool_observations",
        0,
        "part_index",
      ]);
      expect(context.entries.filter((entry) => entry.action)).toHaveLength(3);
      expect(
        context.entries.find(
          (entry) => entry.value.tool_call_id === "image" && entry.action,
        )?.action?.results,
      ).toHaveLength(2);
    },
  );

  it("diagnoses observation metadata even when the request has no action", async () => {
    const value = cancelledRecord(1, null, false);
    value.request!.response = page([
      response([{ part_kind: "text", content: "Saved text" }]),
    ]);
    const data = await read([value]);
    const context = composeContext(2, [data]);
    expect(context.diagnostics).toHaveLength(3);
    expect(
      context.entries.some((entry) => entry.value.content === "Saved text"),
    ).toBe(true);
    expect(
      context.entries.some((entry) => entry.value.part_kind === "tool-return"),
    ).toBe(true);
  });

  it("keeps duplicated observation identity diagnostic and preserves the real result", async () => {
    const value = cancelledRecord(1, at, true);
    observations(value).push(structuredClone(observations(value)[0]));
    const data = await read([value]);
    const context = composeContext(2, [data]);
    const action = context.entries.find(
      (entry) => entry.value.tool_call_id === "cancelled" && entry.action,
    )?.action;
    expect(
      context.diagnostics.some((item) => item.reason.includes("duplicated")),
    ).toBe(true);
    expect(action?.lifecycle).toBeUndefined();
    expect(action?.results).toHaveLength(1);
  });

  it("retains a real result when an observation claims no result", async () => {
    const value = cancelledRecord(1, null, false);
    const message = value.request!.related.messages[0] as Record<
      string,
      HistoryValue
    >;
    const parts = message.parts as Record<string, HistoryValue>[];
    parts[0].outcome = "success";
    parts[0].content = "Actual result";
    const data = await read([value]);
    const context = composeContext(2, [data]);
    const action = context.entries.find(
      (entry) => entry.value.tool_call_id === "cancelled" && entry.action,
    )?.action;
    expect(context.diagnostics[0].location.path.slice(-1)).toEqual([
      "has_result",
    ]);
    expect(action?.results[0].value.content).toBe("Actual result");
    expect(action?.lifecycle).toBeUndefined();
  });

  it("validates every result position before changing associations", async () => {
    const value = cancelledRecord(1, at, true);
    observations(value)[0].result_positions = [
      [0, 0],
      [9, 0],
    ];
    const data = await read([value]);
    const context = composeContext(2, [data]);
    const action = context.entries.find(
      (entry) => entry.value.tool_call_id === "cancelled" && entry.action,
    )?.action;
    expect(context.diagnostics[0].location.path.slice(-2)).toEqual([
      "result_positions",
      1,
    ]);
    expect(action?.results).toHaveLength(1);
    expect(action?.lifecycle).toBeUndefined();
    expect(action?.observationError).toBeDefined();
  });

  it("preserves successful requests around an invalid request without sharing its prefix", async () => {
    const values = [record(1), record(2), record(3)];
    for (const value of values) {
      value.run.request_count = 3;
      value.requests = values.map((item) => item.request!.summary);
    }
    values[1].request!.response = page([{ kind: "response", parts: [null] }]);
    const data = await read(values);
    const identities = new Map<string, string>();
    const context = composeContext(2, [data], {}, identities);
    expect(context.diagnostics).toHaveLength(1);
    expect(context.diagnostics[0].location.ordinal).toBe(2);
    expect(
      context.entries
        .filter((entry) => entry.value.content === "工作记录")
        .map((entry) => entry.ordinal),
    ).toEqual([1, 3]);
    expect(
      context.entries.filter((entry) => entry.title === "Session context"),
    ).toHaveLength(2);
    expect([...identities.keys()].some((key) => JSON.parse(key)[3] === 2)).toBe(
      false,
    );
    expect(
      context.coverage.some(
        (item) => item.location.ordinal === 2 && item.target === "Full context",
      ),
    ).toBe(true);
  });

  it("keeps response observations pending until the response snapshot is complete", async () => {
    const data = await read([cancelledRecord(1, null, false)]);
    const snapshot = data.contents[1];
    const partial = {
      ...data,
      contents: {
        1: {
          ...snapshot,
          complete: false,
          values: { related: snapshot.values.related },
        },
      },
    };
    const context = composeContext(2, [partial]);
    expect(context.diagnostics).toEqual([]);
    expect(
      context.entries.filter((entry) => entry.action?.readingObservation),
    ).toHaveLength(3);
    expect(
      context.entries.some((entry) => entry.action?.lifecycle !== undefined),
    ).toBe(false);
  });

  it("diagnoses complete observations without a saved response after every reader publication", async () => {
    const value = cancelledRecord(1, null, false);
    value.request!.response = null;
    const original = structuredClone(value);
    const states: ActivityData[] = [];
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const data = await loadActivity(
      2,
      4,
      new AbortController().signal,
      (state) => states.push(state),
    );
    const partial = states.filter((state) => !state.contents[1]?.complete);
    expect(partial.length).toBeGreaterThan(0);
    for (const state of partial)
      expect(composeContext(2, [state]).diagnostics).toEqual([]);
    const context = composeContext(2, [data]);
    expect(context.diagnostics).toHaveLength(3);
    expect(context.diagnostics[0]).toMatchObject({
      reason: "Saved observation does not identify a response tool call",
      location: {
        sequence: 4,
        ordinal: 1,
        source: "related",
        path: ["metadata", "fora", "tool_observations", 0, "part_index"],
      },
    });
    expect(
      context.entries.filter(
        (entry) => entry.value.part_kind === "tool-return",
      ),
    ).toHaveLength(3);
    expect(value).toEqual(original);
  });

  it("uses complete metadata values and treats intermediate snapshots as reading", async () => {
    const value = cancelledRecord(1, null, false);
    const saved = observations(value)[0];
    const rawTime = {
      kind: "text",
      source: "related",
      request_ordinal: 1,
      message_index: 0,
      path: ["metadata", "fora", "tool_observations", 0, "completed_at"],
      offset: 0,
      next_offset: 1,
      total_bytes: 2,
      value: "a",
      has_more: true,
    };
    saved.completed_at = rawTime;
    vi.spyOn(backend, "agentHistoryText").mockResolvedValue({
      offset: 1,
      next_offset: 2,
      total_bytes: 2,
      value: "b",
      has_more: false,
    });
    const states: ActivityData[] = [];
    vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(value);
    const data = await loadActivity(
      2,
      4,
      new AbortController().signal,
      (state) => states.push(state),
    );
    const pending = states.find(
      (state) => state.contents[1] && !state.contents[1].complete,
    );
    expect(pending).toBeDefined();
    const reading = composeContext(2, [pending!]);
    expect(reading.diagnostics).toEqual([]);
    expect(
      reading.entries.some((entry) => entry.action?.readingObservation),
    ).toBe(true);
    const context = composeContext(2, [data]);
    expect(context.diagnostics).toEqual([]);
    expect(
      context.entries.find(
        (entry) => entry.value.tool_call_id === "cancelled" && entry.action,
      )?.action?.lifecycle?.completed_at,
    ).toBe("ab");
    expect(saved.completed_at).toEqual(rawTime);
  });
});

describe("saved context composition", () => {
  it.each([
    [null, false],
    [at, false],
    [null, true],
    [at, true],
  ] as const)(
    "preserves cancellation with started_at=%s and has_result=%s alongside real returns and images",
    async (started, hasResult) => {
      const value = cancelledRecord(1, started, hasResult);
      const original = structuredClone(value);
      const imageRead = vi.spyOn(backend, "agentHistoryImage");
      const data = await read([value]);
      const context = composeContext(2, [data]);
      const actions = context.entries.flatMap((entry) =>
        entry.action ? [entry.action] : [],
      );
      expect(actions).toHaveLength(3);
      expect(actions[0].lifecycle).toEqual({
        status: "cancelled",
        started_at: started,
        completed_at: at,
        saved: true,
        has_result: hasResult,
        content_version: "cancelled-1",
      });
      expect(actions[0].results).toHaveLength(hasResult ? 1 : 0);
      expect(actions[1].lifecycle?.has_result).toBe(true);
      expect(actions[1].results).toHaveLength(1);
      expect(actions[1].results[0].value.outcome).toBe("interrupted");
      expect(actions[2].results.map((result) => result.partIndex)).toEqual([
        2, 3,
      ]);
      expect(actions[2].results[1].value.content).toEqual([
        {
          kind: "binary",
          source: "related",
          request_ordinal: 1,
          message_index: 0,
          path: ["parts", 3, "content", 0],
          media_type: "image/png",
          size: 3,
          identifier: "same",
        },
      ]);
      expect(
        context.entries.filter(
          (entry) => entry.value.part_kind === "tool-return",
        ),
      ).toEqual([]);
      const originalPart = context.coverage.filter(
        (item) =>
          item.location.source === "related" &&
          item.location.messageIndex === 0 &&
          item.location.path[0] === "parts" &&
          item.location.path[1] === 0,
      );
      expect(originalPart.map((item) => item.location.path[2])).toEqual([
        "part_kind",
        "tool_name",
        "tool_call_id",
        "outcome",
        "content",
        "timestamp",
      ]);
      expect(
        originalPart.every(
          (item) =>
            item.target === (hasResult ? actions[0].key : "Full context") &&
            item.kind === (hasResult ? "content" : "inspection"),
        ),
      ).toBe(true);
      expect(data.contents[1].request.related.messages).toEqual(
        original.request?.related.messages,
      );
      expect(value).toEqual(original);
      expect(imageRead).not.toHaveBeenCalled();
      expect(context.missing).toEqual([
        "The saved context source could not be confirmed",
      ]);
    },
  );

  it("keeps cumulative cancellation positions separate from a later identical real return", async () => {
    const first = cancelledRecord(1, null, false);
    const second = cancelledRecord(2, at, true);
    if (!first.request || !second.request) throw new Error("Missing request");
    for (const value of [first, second]) {
      const request = value.request;
      if (!request) throw new Error("Missing request");
      const responseMessage = request.response?.messages[0] as Record<
        string,
        HistoryValue
      >;
      const relatedMessage = request.related.messages[0] as Record<
        string,
        HistoryValue
      >;
      responseMessage.parts = (responseMessage.parts as HistoryValue[]).slice(
        0,
        2,
      );
      relatedMessage.parts = (relatedMessage.parts as HistoryValue[]).slice(
        0,
        2,
      );
      const metadata = relatedMessage.metadata as Record<string, HistoryValue>;
      const fora = metadata.fora as Record<string, HistoryValue>;
      fora.tool_observations = (fora.tool_observations as HistoryValue[]).slice(
        0,
        2,
      );
      value.run.request_count = 2;
      value.requests = [first.requests[0], second.requests[0]];
    }
    second.request.input = page([
      ...first.request.input.messages,
      ...(first.request.response?.messages ?? []),
      ...first.request.related.messages,
    ]);
    const data = await read([first, second]);
    const context = composeContext(2, [data]);
    const actions = context.entries.flatMap((entry) =>
      entry.action ? [entry.action] : [],
    );
    expect(
      actions.map((action) => [action.ordinal, action.results.length]),
    ).toEqual([
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 1],
    ]);
    expect(actions[2].results[0].value.tool_call_id).toBe("cancelled");
    expect(actions[2].results[0].value.outcome).toBe("interrupted");
    expect(
      context.entries.filter(
        (entry) => entry.value.part_kind === "tool-return",
      ),
    ).toEqual([]);
    for (const [ordinal, source, messageIndex] of [
      [1, "related", 0],
      [2, "input", 2],
    ] as const) {
      const positions = context.coverage.filter(
        (item) =>
          item.location.ordinal === ordinal &&
          item.location.source === source &&
          item.location.messageIndex === messageIndex &&
          item.location.path[0] === "parts" &&
          item.location.path[1] === 0,
      );
      expect(positions).toHaveLength(6);
      expect(
        positions.every(
          (item) =>
            item.target === "Full context" && item.kind === "inspection",
        ),
      ).toBe(true);
    }
    expect(
      context.coverage.some(
        (item) =>
          item.location.ordinal === 2 &&
          item.location.source === "related" &&
          item.location.path.join("/") === "parts/0/content" &&
          item.target === actions[2].key &&
          item.kind === "content",
      ),
    ).toBe(true);
    expect(context.missing).toEqual([]);
  });
});

function generated(partIndex = 0, partKind = "text"): GenerationPart {
  return {
    key: {
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      part_index: partIndex,
      request_id: "request-1",
      run_id: "fora-4",
    },
    part_kind: partKind,
    revision: 1,
    status: "generating",
    error: null,
    created_at: at,
    updated_at: at,
    tool_name: partKind === "tool-call" ? "discussion" : null,
    tool_call_id: partKind === "tool-call" ? "actual-call" : null,
  };
}

it("keeps the content identity when generation becomes a saved response", async () => {
  const pending = record();
  if (!pending.request) throw new Error("Missing request");
  pending.request.response = null;
  pending.request.summary.status = "pending";
  const data = await read([pending]);
  const identities = new Map<string, string>();
  const current = composeContext(2, [data], {}, identities, [generated()]);
  const entry = current.entries.find((entry) => entry.generation);
  expect(entry?.value.part_kind).toBe("text");
  expect(entry?.location.path).toEqual(["parts", 0]);
  vi.mocked(backend.agentHistoryRead).mockResolvedValue(record());
  const saved = await loadActivity(
    2,
    4,
    new AbortController().signal,
    () => {},
  );
  const completed = composeContext(2, [saved], {}, identities, [generated()]);
  const formal = completed.entries.find(
    (entry) => entry.value.content === "工作记录",
  );
  expect(formal?.key).toBe(entry?.key);
  expect(
    completed.entries.filter((entry) => entry.value.part_kind === "text"),
  ).toHaveLength(1);
  expect(completed.entries.some((entry) => entry.generation)).toBe(false);
});

it("keeps actual generated tool identity and independent thinking content", async () => {
  const pending = record();
  if (!pending.request) throw new Error("Missing request");
  pending.request.response = null;
  const data = await read([pending]);
  const context = composeContext(2, [data], {}, new Map(), [
    generated(0, "thinking"),
    generated(1, "tool-call"),
  ]);
  const thinking = context.entries.find(
    (entry) => entry.value.part_kind === "thinking",
  );
  const action = context.entries.find((entry) => entry.action);
  expect(thinking?.generation?.key.part_index).toBe(0);
  expect(action?.action?.value.tool_call_id).toBe("actual-call");
  expect(action?.action?.requestId).toBe("request-1");
  expect(action?.generation?.key.part_index).toBe(1);
});

it("preserves one response unit when a live response and its durable generation coexist", async () => {
  const value = record();
  if (!value.request) throw new Error("Missing request");
  value.request.response_saved = false;
  const context = composeContext(2, [await read([value])], {}, new Map(), [
    generated(),
  ]);
  const texts = context.entries.filter(
    (entry) => entry.value.part_kind === "text",
  );
  expect(texts).toHaveLength(1);
  expect(texts[0].generation?.key.request_id).toBe("request-1");
});

it("ignores generation outside the recorded request identity", async () => {
  const data = await read([record()]);
  const wrong = generated();
  wrong.key.request_id = "another-request";
  const context = composeContext(2, [data], {}, new Map(), [wrong]);
  expect(context.entries.some((entry) => entry.generation)).toBe(false);
});

describe("saved context composition", () => {
  it.each(["response", "related"] as const)(
    "composes every published %s update with its own values",
    async (source) => {
      const first = record();
      const second = record();
      if (!first.request || !second.request) throw new Error("Missing request");
      first.request.response = page([
        response([
          {
            part_kind: "tool-call",
            tool_name: "run",
            tool_call_id: "read",
            args: { argv: ["cat", "资料.md"] },
          },
        ]),
      ]);
      second.request.response = first.request.response;
      first.request[source] = page([]);
      second.request.related = page([
        {
          kind: "request",
          parts: [
            {
              part_kind: "tool-return",
              tool_name: "run",
              tool_call_id: "read",
              content: "saved result",
            },
          ],
        },
      ]);
      let saved = await read([first]);
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(second);
      const controller = new AbortController();
      let publications = 0;
      await loadActivity(2, 4, controller.signal, (data) => {
        saved = mergeActivityData(saved, data);
        expect(() => composeContext(2, [saved])).not.toThrow();
        for (const snapshot of Object.values(data.contents))
          expect(snapshot.readId).toBe(controller.signal);
        publications += 1;
      });
      expect(publications).toBeGreaterThanOrEqual(3);
      expect(saved.contents[1].readId).toBe(controller.signal);
      expect(
        composeContext(2, [saved]).entries.find((entry) => entry.action)?.action
          ?.results[0]?.value.content,
      ).toBe("saved result");
    },
  );

  it("retains a completed snapshot while appended parts and text are being read", async () => {
    const first = record();
    const second = record();
    if (!first.request || !second.request) throw new Error("Missing request");
    first.request.response = page([
      response([{ part_kind: "text", content: "saved original" }]),
    ]);
    second.request.response = page([
      response([
        { part_kind: "text", content: "saved original" },
        {
          part_kind: "text",
          content: {
            kind: "text",
            source: "response",
            request_ordinal: 1,
            message_index: 0,
            path: ["parts", 1, "content"],
            offset: 0,
            next_offset: 3,
            total_bytes: 6,
            value: "new",
            has_more: true,
          },
        },
      ]),
    ]);
    let saved = await read([first]);
    const original = saved.contents[1];
    let resolve!: (value: {
      offset: number;
      next_offset: number;
      total_bytes: number;
      value: string;
      has_more: boolean;
    }) => void;
    const waiting = new Promise<{
      offset: number;
      next_offset: number;
      total_bytes: number;
      value: string;
      has_more: boolean;
    }>((yes) => {
      resolve = yes;
    });
    vi.spyOn(backend, "agentHistoryText").mockReturnValue(waiting);
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(second);
    const operation = loadActivity(
      2,
      4,
      new AbortController().signal,
      (data) => {
        saved = mergeActivityData(saved, data);
        const context = composeContext(2, [saved]);
        expect(
          context.entries.some(
            (entry) => entry.resolved.content === "saved original",
          ),
        ).toBe(true);
      },
    );
    await vi.waitFor(() =>
      expect(backend.agentHistoryText).toHaveBeenCalledOnce(),
    );
    expect(saved.contents[1]).toBe(original);
    expect(saved.pending).toContain(1);
    resolve({
      offset: 3,
      next_offset: 6,
      total_bytes: 6,
      value: "est",
      has_more: false,
    });
    await operation;
    expect(saved.contents[1]).not.toBe(original);
    expect(
      composeContext(2, [saved]).entries.some(
        (entry) => entry.resolved.content === "newest",
      ),
    ).toBe(true);
  });

  it.each(["success", "failure"] as const)(
    "keeps the active snapshot when an interrupted text read returns late with %s",
    async (condition) => {
      const first = record();
      const changed = record();
      if (!first.request || !changed.request)
        throw new Error("Missing request");
      changed.request.response = page([
        response([
          {
            part_kind: "text",
            content: {
              kind: "text",
              source: "response",
              request_ordinal: 1,
              message_index: 0,
              path: ["parts", 0, "content"],
              offset: 0,
              next_offset: 3,
              total_bytes: 6,
              value: "old",
              has_more: true,
            },
          },
        ]),
      ]);
      let saved = await read([first]);
      let resolve!: (value: {
        offset: number;
        next_offset: number;
        total_bytes: number;
        value: string;
        has_more: boolean;
      }) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<{
        offset: number;
        next_offset: number;
        total_bytes: number;
        value: string;
        has_more: boolean;
      }>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      vi.spyOn(backend, "agentHistoryText").mockReturnValue(pending);
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(changed);
      const controller = new AbortController();
      const interrupted = loadActivity(2, 4, controller.signal, (data) => {
        saved = mergeActivityData(saved, data);
        expect(() => composeContext(2, [saved])).not.toThrow();
      });
      const rejected = expect(interrupted).rejects.toThrow();
      await vi.waitFor(() =>
        expect(backend.agentHistoryText).toHaveBeenCalledOnce(),
      );
      controller.abort();
      const current = record();
      if (!current.request) throw new Error("Missing request");
      current.request.parameters.value = JSON.stringify({
        instruction_parts: [{ content: "current instructions" }],
      });
      current.request.response = page([
        response([{ part_kind: "text", content: "current saved text" }]),
      ]);
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(current);
      await loadActivity(2, 4, new AbortController().signal, (data) => {
        saved = mergeActivityData(saved, data);
      });
      const active = saved.contents[1];
      if (condition === "success")
        resolve({
          offset: 3,
          next_offset: 6,
          total_bytes: 6,
          value: "end",
          has_more: false,
        });
      else reject(new Error("interrupted result"));
      await rejected;
      expect(saved.contents[1]).toBe(active);
      const context = composeContext(2, [saved]);
      expect(
        context.entries.some(
          (entry) => entry.resolved.content === "current saved text",
        ),
      ).toBe(true);
      expect(
        context.entries.some(
          (entry) => entry.resolved.content === "current instructions",
        ),
      ).toBe(true);
      expect(
        context.entries.some((entry) => entry.resolved.content === "oldend"),
      ).toBe(false);
    },
  );

  it("shares adjacent Legacy prefixes while preserving all saved positions and independent actions", async () => {
    const template = await read([record()]);
    const firstText = response([{ part_kind: "text", content: "earlier" }]);
    const call = response([
      {
        part_kind: "tool-call",
        tool_name: "run",
        tool_call_id: "same",
        args: { argv: ["pwd"] },
      },
    ]);
    const returned = {
      kind: "request",
      parts: [
        {
          part_kind: "tool-return",
          tool_name: "run",
          tool_call_id: "same",
          content: "done",
        },
      ],
    };
    const snapshots = [
      [firstText],
      [firstText, call, returned],
      [
        firstText,
        call,
        returned,
        call,
        returned,
        response([{ part_kind: "text", content: "ending" }]),
      ],
    ].map((legacy, index) => ({
      ...template,
      run: {
        ...template.run,
        sequence: index + 1,
        request_count: 0,
        legacy: true,
      },
      requests: [],
      contents: {},
      legacy,
      legacyBoundary: 1,
    }));
    const context = composeContext(2, snapshots);
    expect(
      context.entries.filter((entry) => entry.resolved.content === "earlier"),
    ).toHaveLength(1);
    expect(context.entries.filter((entry) => entry.action)).toHaveLength(2);
    expect(
      context.entries
        .filter((entry) => entry.action)
        .map((entry) => entry.action?.results.length),
    ).toEqual([1, 1]);
    expect(
      context.entries
        .find((entry) => entry.resolved.content === "earlier")
        ?.references.map((reference) => reference.sequence),
    ).toEqual([1, 2, 3]);
    expect(context.missing).toEqual([]);
    const partial = composeContext(2, [snapshots[2]]);
    expect(
      partial.entries.some((entry) => entry.resolved.content === "earlier"),
    ).toBe(true);
    expect(partial.missing).toContain(
      "The preceding saved history has not been loaded",
    );
    const anotherWindow = {
      ...snapshots[2],
      run: { ...snapshots[2].run, window_number: 2 },
      legacyBoundary: 3,
    };
    expect(
      composeContext(2, [snapshots[0], anotherWindow]).entries.filter(
        (entry) => entry.resolved.content === "earlier",
      ),
    ).toHaveLength(2);
  });

  it("uses the same successful reply and ending rules for cumulative Legacy snapshots", async () => {
    const template = await read([record()]);
    const call = response([
      {
        part_kind: "tool-call",
        tool_name: "discussion",
        tool_call_id: "send",
        args: { action: "send", discussion_id: 8, body: "发送原文" },
      },
    ]);
    const receipt = {
      kind: "request",
      parts: [
        {
          part_kind: "tool-return",
          tool_name: "discussion",
          tool_call_id: "send",
          content: { discussion_id: 8, id: 14, created_at: at },
        },
      ],
    };
    const first = {
      ...template,
      run: { ...template.run, sequence: 1, request_count: 0, legacy: true },
      requests: [],
      contents: {},
      legacy: [
        call,
        receipt,
        response([{ part_kind: "text", content: "发送原文" }]),
      ],
      legacyBoundary: 1,
    };
    const second = {
      ...first,
      run: { ...first.run, sequence: 2 },
      legacy: [
        ...first.legacy,
        response([{ part_kind: "text", content: "另一份结束原文" }]),
      ],
    };
    const context = composeContext(2, [first, second]);
    expect(
      context.entries.filter((entry) => entry.reply === "发送原文"),
    ).toHaveLength(1);
    expect(
      context.entries
        .filter((entry) => entry.workRecord)
        .map((entry) => entry.resolved.content),
    ).toEqual(["另一份结束原文"]);
    const reply = context.entries.find((entry) => entry.reply);
    expect(
      context.coverage.some(
        (item) =>
          item.location.sequence === 1 &&
          item.location.messageIndex === 2 &&
          item.target === reply?.key,
      ),
    ).toBe(true);
    expect(
      context.coverage.some(
        (item) =>
          item.location.sequence === 2 &&
          item.location.messageIndex === 2 &&
          item.target === reply?.key,
      ),
    ).toBe(true);
    expect(context.missing).toEqual([]);
  });

  it("diagnoses a genuinely inconsistent completed message snapshot", async () => {
    const data = await read([record()]);
    const next = await read([record(2)]);
    const snapshot = data.contents[1];
    const combined: ActivityData = {
      ...data,
      requests: [...data.requests, ...next.requests],
      contents: {
        ...data.contents,
        ...next.contents,
        1: { ...snapshot, values: { ...snapshot.values, input: [] } },
      },
    };
    const original = structuredClone(combined);
    for (const [ordinal, snapshot] of Object.entries(combined.contents))
      original.contents[Number(ordinal)].readId = snapshot.readId;
    const identities = new Map([["unrelated", "stable"]]);
    const context = composeContext(2, [combined], {}, identities);
    expect(context.diagnostics).toHaveLength(1);
    expect(context.diagnostics[0].reason).toBe(
      "Complete context does not match its saved message page",
    );
    expect(context.diagnostics[0].location).toMatchObject({
      sequence: 4,
      ordinal: 1,
      source: "input",
    });
    expect(context.entries.some((entry) => entry.ordinal === 1)).toBe(false);
    expect(
      context.entries.some(
        (entry) => entry.ordinal === 2 && entry.value.content === "工作记录",
      ),
    ).toBe(true);
    expect(
      context.coverage.some(
        (item) => item.location.ordinal === 1 && item.target === "Full context",
      ),
    ).toBe(true);
    expect(
      [...identities.keys()]
        .filter((key) => key !== "unrelated")
        .every((key) => JSON.parse(key)[3] === 2),
    ).toBe(true);
    expect(identities.get("unrelated")).toBe("stable");
    expect(combined).toEqual(original);
  });

  it("preserves Legacy image locations before and after byte confirmation", async () => {
    const template = await read([record()]);
    const binary: HistoryBinary = {
      kind: "binary",
      source: "run",
      message_index: 1,
      path: ["parts", 0, "content"],
      media_type: "image/png",
      size: 3,
      identifier: "same",
    };
    const copied = { ...binary };
    const call = response([
      {
        part_kind: "tool-call",
        tool_name: "view_image",
        tool_call_id: "image",
        args: { path: "图.png" },
      },
    ]);
    const returned = {
      kind: "request",
      parts: [
        {
          part_kind: "tool-return",
          tool_name: "view_image",
          tool_call_id: "image",
          content: binary,
        },
      ],
    };
    const first = {
      ...template,
      run: { ...template.run, sequence: 1, request_count: 0, legacy: true },
      requests: [],
      contents: {},
      legacy: [call, returned],
      legacyBoundary: 1,
    };
    const second = {
      ...first,
      run: { ...first.run, sequence: 2 },
      legacy: [
        call,
        { ...returned, parts: [{ ...returned.parts[0], content: copied }] },
        response([{ part_kind: "text", content: "结束原文" }]),
      ],
    };
    const pending = composeContext(2, [first, second]);
    expect(
      pending.entries.find((entry) => entry.action)?.action?.results,
    ).toHaveLength(2);
    const images = {
      [contextImageKey(1, binary)]: {
        media_type: "image/png",
        data: "YWJj",
        size: 3,
        identifier: "same",
      },
      [contextImageKey(2, copied)]: {
        media_type: "image/png",
        data: "YWJj",
        size: 3,
        identifier: "same",
      },
    };
    const confirmed = composeContext(2, [first, second], images);
    expect(
      confirmed.entries.find((entry) => entry.action)?.action?.results,
    ).toHaveLength(1);
    expect(
      confirmed.coverage.map((item) => contextLocationKey(item.location)),
    ).toEqual(
      pending.coverage.map((item) => contextLocationKey(item.location)),
    );
    expect(confirmed.missing).toEqual([]);
  });

  it.each([null, { fora: { block: "resident" } }])(
    "preserves a merged legacy request with unknown part sources %s",
    async (metadata) => {
      const value = record();
      if (!value.request) throw new Error("Missing request");
      value.request.input.messages[0] = {
        ...(value.request.input.messages[0] as Record<string, HistoryValue>),
        metadata,
      };
      const context = composeContext(2, [await read([value])]);
      expect(context.entries.filter((entry) => entry.reminder)).toHaveLength(0);
      expect(
        context.entries.filter((entry) => entry.title === "Session context"),
      ).toHaveLength(0);
      expect(
        context.entries.find((entry) => entry.value.content === prompt)?.title,
      ).toBe("Context");
      expect(context.missing).toContain(
        "The saved context source could not be confirmed",
      );
    },
  );

  it.each([
    "version",
    "index",
    "kind",
    "agent",
    "sequence",
    "duplicate",
    "type",
    "metadata_field",
    "part_field",
  ])(
    "preserves original content when source metadata has an invalid %s",
    async (condition) => {
      const value = record();
      if (!value.request) throw new Error("Missing request");
      const message = value.request.input.messages[0] as Record<
        string,
        HistoryValue
      >;
      const metadata = marker([
        { part_index: 0, kind: "session_context", source_id: "session" },
        { part_index: 1, kind: "reminder", source_id: "reminder" },
      ]);
      if (condition === "version") metadata.fora.context_sources.version = 2;
      if (condition === "index")
        metadata.fora.context_sources.parts[1].part_index = 2;
      if (condition === "kind")
        metadata.fora.context_sources.parts[1].kind = "unknown";
      if (condition === "agent")
        metadata.fora.context_sources.parts[1].agent_id = 3;
      if (condition === "sequence")
        metadata.fora.context_sources.parts[1].sequence = 5;
      if (condition === "duplicate")
        metadata.fora.context_sources.parts[1].part_index = 0;
      if (condition === "type")
        (message.parts as Record<string, HistoryValue>[])[1].part_kind = "text";
      if (condition === "metadata_field")
        Object.assign(metadata.fora.context_sources, { other: true });
      if (condition === "part_field")
        Object.assign(metadata.fora.context_sources.parts[1], { other: true });
      message.metadata = metadata;
      const context = composeContext(2, [await read([value])]);
      expect(context.entries.filter((entry) => entry.reminder)).toHaveLength(0);
      expect(
        context.entries.some((entry) => entry.value.content === prompt),
      ).toBe(true);
      expect(context.missing).toContain(
        "Saved context source metadata is invalid or unsupported",
      );
    },
  );

  it("retains malformed saved arguments and their diagnostic while continuing later requests", async () => {
    const first = record(1);
    const second = record(2);
    if (!first.request || !second.request) throw new Error("Missing request");
    first.request.response = page([
      response([
        {
          part_kind: "tool-call",
          tool_name: "discussion",
          tool_call_id: "broken",
          args: '{"action":"send",',
        },
      ]),
    ]);
    first.request.related = page([
      {
        ...user(""),
        parts: [
          {
            part_kind: "retry-prompt",
            tool_call_id: "broken",
            tool_name: "discussion",
            content: "saved parser error",
          },
        ],
      },
    ]);
    second.request.input = page([
      ...first.request.input.messages,
      ...first.request.response.messages,
      ...first.request.related.messages,
    ]);
    for (const item of [first, second]) {
      item.run = { ...item.run, request_count: 2 };
      item.requests = [first.requests[0], second.requests[0]];
    }
    const data = await read([first, second]);
    expect(data.complete).toBe(true);
    const context = composeContext(2, [data]);
    expect(context.entries.find((entry) => entry.action)?.action?.args).toBe(
      '{"action":"send",',
    );
    expect(
      context.entries.find((entry) => entry.action)?.diagnostic,
    ).toBeTruthy();
    expect(
      context.entries.find((entry) => entry.action)?.reply,
    ).toBeUndefined();
    expect(context.entries.some((entry) => entry.workRecord)).toBe(true);
  });

  it("covers empty saved part arrays and unknown typed fields at their exact positions", async () => {
    const value = record();
    if (!value.request) throw new Error("Missing request");
    value.request.response = page([
      {
        kind: "response",
        parts: [],
        metadata: { unknown: [], flag: false, amount: 0, absent: null },
      },
    ]);
    const context = composeContext(2, [await read([value])]);
    const expected = [
      "parts",
      "metadata/unknown",
      "metadata/flag",
      "metadata/amount",
      "metadata/absent",
    ];
    for (const path of expected)
      expect(
        context.coverage.some(
          (item) =>
            item.location.source === "response" &&
            item.location.path.join("/") === path &&
            item.kind === "inspection",
        ),
      ).toBe(true);
  });

  it("uses complete values when matching a repeated source with a long identical prefix", async () => {
    const first = record(1);
    const second = record(2);
    if (!first.request || !second.request) throw new Error("Missing request");
    const prefix = "中文说明😀".repeat(2000);
    const source = marker([
      { part_index: 0, kind: "ephemeral", source_id: "long-source" },
    ]);
    first.request.input.messages.push({
      ...user(`${prefix}甲`),
      metadata: source,
    });
    second.request.input.messages.push({
      ...user(`${prefix}乙`),
      metadata: source,
    });
    for (const item of [first, second]) {
      item.run = { ...item.run, request_count: 2 };
      item.requests = [first.requests[0], second.requests[0]];
    }
    const context = composeContext(2, [await read([first, second])]);
    expect(
      context.entries.filter(
        (entry) =>
          typeof entry.resolved.content === "string" &&
          entry.resolved.content.startsWith(prefix),
      ),
    ).toHaveLength(2);
  });

  it("uses saved Reminder identity when the mention list is empty", async () => {
    const value = record();
    value.run.reminded = [];
    const context = composeContext(2, [await read([value])]);
    expect(context.entries.find((entry) => entry.reminder)?.value.content).toBe(
      prompt,
    );
    expect(context.missing).toEqual([]);
  });

  it("preserves original activity ownership across decoded cumulative inputs and identical prompt text", async () => {
    const first = record(1, 4);
    const second = record(1, 5);
    first.run.started_at = "2026-10-07T10:00:00Z";
    if (!first.request || !second.request) throw new Error("Missing request");
    second.request.input = page([
      ...first.request.input.messages,
      ...(first.request.response?.messages ?? []),
      {
        ...user(prompt),
        run_id: null,
        metadata: marker(
          [{ part_index: 0, kind: "reminder", source_id: "reminder-5" }],
          5,
        ),
      },
    ]);
    const older = await read([first]);
    const newer = await read([second]);
    const context = composeContext(2, [older, newer]);
    const reminders = context.entries.filter((entry) => entry.reminder);
    expect(reminders).toHaveLength(2);
    expect(reminders.map((entry) => entry.timestamp)).toEqual([
      first.run.started_at,
      at,
    ]);
    expect(
      reminders[0].references.map((reference) => reference.sequence),
    ).toEqual([4, 5]);
    expect(reminders[1].contextSource?.sequence).toBe(5);
  });

  it("records unavailable original Reminder timing without substituting the reading activity time", async () => {
    const value = record(1, 5);
    if (!value.request) throw new Error("Missing request");
    const message = value.request.input.messages[0] as Record<
      string,
      HistoryValue
    >;
    message.metadata = marker(
      [
        {
          part_index: 0,
          kind: "session_context",
          source_id: "session",
          sequence: 4,
        },
        { part_index: 1, kind: "reminder", source_id: "reminder", sequence: 4 },
      ],
      5,
    );
    const context = composeContext(2, [await read([value])]);
    expect(
      context.entries.find((entry) => entry.reminder)?.timestamp,
    ).toBeNull();
    expect(context.missing).toContain(
      "The original reminder start time is unavailable",
    );
  });

  it("preserves merged session content, instructions and the complete reminder at its SDK prompt position", async () => {
    const value = record();
    if (!value.request) throw new Error("Missing request");
    value.request.parameters.value = JSON.stringify({
      instruction_parts: [{ content: "维护社区网站", priority: 0 }],
      tools: [{ name: "discussion" }],
    });
    value.request.input.messages.push({
      ...user("环境已经变化"),
      metadata: marker([
        { part_index: 0, kind: "environment", source_id: "environment" },
      ]),
    });
    const data = await read([value]);
    const context = composeContext(2, [data]);
    expect(context.entries.map((entry) => entry.title)).toEqual([
      "Instructions",
      "Session context",
      null,
      "Environment",
      null,
    ]);
    expect(context.entries.filter((entry) => entry.reminder)).toHaveLength(1);
    expect(context.entries.find((entry) => entry.reminder)?.value.content).toBe(
      prompt,
    );
    expect(context.entries.find((entry) => entry.reminder)?.timestamp).toBe(at);
    expect(
      context.entries.find((entry) => entry.title === "Session context")?.value
        .content,
    ).toContain("Environment\n这行属于原记忆");
    expect(
      context.coverage.find(
        (item) =>
          item.location.source === "parameters" &&
          item.location.path.join("/") === "tools/0/name",
      )?.target,
    ).toBe("Full context");
    expect(context.missing).toEqual([]);
  });

  it("references cumulative input, response and related positions while retaining an independent repeated action", async () => {
    const first = record(1);
    const second = record(2);
    if (!first.request || !second.request) throw new Error("Missing request");
    const call = response([
      {
        part_kind: "tool-call",
        tool_name: "run",
        tool_call_id: "same",
        args: { argv: ["cat", "资料.md"], cwd: "/project/资料" },
      },
    ]);
    const returned = {
      ...user(""),
      parts: [
        {
          part_kind: "tool-return",
          tool_name: "run",
          tool_call_id: "same",
          content: {
            stdout: "读取完成",
            stderr: "",
            exit_code: 0,
            truncated: false,
          },
        },
      ],
    };
    first.request.response = page([call]);
    first.request.related = page([returned]);
    second.request.input = page([
      ...first.request.input.messages,
      call,
      returned,
    ]);
    second.request.response = page([call]);
    second.request.related = page([returned]);
    for (const item of [first, second]) {
      item.run = { ...item.run, request_count: 2 };
      item.requests = [first.requests[0], second.requests[0]];
    }
    const data = await read([first, second]);
    const context = composeContext(2, [data]);
    expect(context.entries.filter((entry) => entry.action)).toHaveLength(2);
    expect(
      context.entries
        .filter((entry) => entry.action)
        .map((entry) => entry.action?.results.length),
    ).toEqual([1, 1]);
    expect(
      context.coverage.filter((item) => item.kind === "reference").length,
    ).toBeGreaterThan(10);
    const locations = new Set(
      context.coverage.map((item) => contextLocationKey(item.location)),
    );
    for (const source of ["input", "response", "related"]) {
      expect([...locations].some((key) => key.includes(`"${source}"`))).toBe(
        true,
      );
    }
    const args = context.entries.find((entry) => entry.action)?.action?.args;
    expect(args).toEqual({ argv: ["cat", "资料.md"], cwd: "/project/资料" });
  });

  it.each(["different", "identical"])(
    "retains ending text after a successful send with %s content",
    async (condition) => {
      const first = record(1);
      const second = record(2);
      if (!first.request || !second.request) throw new Error("Missing request");
      first.request.response = page([
        response([
          {
            part_kind: "tool-call",
            tool_name: "discussion",
            tool_call_id: "send",
            args: { action: "send", discussion_id: 8, body: "通知已经发送" },
          },
        ]),
      ]);
      first.request.related = page([
        {
          ...user(""),
          parts: [
            {
              part_kind: "tool-return",
              tool_name: "discussion",
              tool_call_id: "send",
              content: { discussion_id: 8, id: 14, created_at: at },
            },
          ],
        },
      ]);
      second.request.input = page([
        ...first.request.input.messages,
        ...first.request.response.messages,
        ...first.request.related.messages,
      ]);
      second.request.response = page([
        response([
          {
            part_kind: "text",
            content:
              condition === "identical" ? "通知已经发送" : "继续维护资料",
          },
        ]),
      ]);
      for (const item of [first, second]) {
        item.run = { ...item.run, request_count: 2 };
        item.requests = [first.requests[0], second.requests[0]];
      }
      const context = composeContext(2, [await read([first, second])]);
      expect(context.entries.find((entry) => entry.reply)?.reply).toBe(
        "通知已经发送",
      );
      expect(context.entries.filter((entry) => entry.workRecord)).toHaveLength(
        condition === "identical" ? 0 : 1,
      );
      expect(
        context.coverage.some(
          (item) =>
            item.location.ordinal === 2 &&
            item.location.source === "response" &&
            item.target === context.entries.find((entry) => entry.reply)?.key,
        ),
      ).toBe(condition === "identical");
    },
  );

  it.each([false, true])(
    "confirms an image overlap only after complete matching bytes are %s",
    async (same) => {
      const first = record(1);
      const second = record(2);
      if (!first.request || !second.request) throw new Error("Missing request");
      const original: HistoryBinary = {
        kind: "binary",
        source: "related",
        request_ordinal: 1,
        message_index: 0,
        path: ["parts", 0, "content", 0],
        media_type: "image/png",
        size: 3,
        identifier: "same",
      };
      const copied: HistoryBinary = {
        ...original,
        source: "input",
        request_ordinal: 2,
        message_index: 2,
      };
      const call = response([
        {
          part_kind: "tool-call",
          tool_name: "view_image",
          tool_call_id: "image",
          args: { path: "配图.png" },
        },
      ]);
      const returned = {
        ...user(""),
        parts: [
          {
            part_kind: "tool-return",
            tool_name: "view_image",
            tool_call_id: "image",
            content: [original],
          },
        ],
      };
      first.request.response = page([call]);
      first.request.related = page([returned]);
      second.request.input = page([
        ...first.request.input.messages,
        call,
        { ...returned, parts: [{ ...returned.parts[0], content: [copied] }] },
      ]);
      for (const item of [first, second]) {
        item.run = { ...item.run, request_count: 2 };
        item.requests = [first.requests[0], second.requests[0]];
      }
      const imageRead = vi.spyOn(backend, "agentHistoryImage");
      const data = await read([first, second]);
      const pending = composeContext(2, [data]);
      expect(
        pending.entries.find((entry) => entry.action)?.action?.results,
      ).toHaveLength(2);
      const images = {
        [contextImageKey(4, original)]: {
          media_type: "image/png",
          data: "YWJj",
          size: 3,
          identifier: "same",
        },
        [contextImageKey(4, copied)]: {
          media_type: "image/png",
          data: same ? "YWJj" : "ZGVm",
          size: 3,
          identifier: "same",
        },
      };
      const complete = composeContext(2, [data], images);
      expect(
        complete.entries.find((entry) => entry.action)?.action?.results,
      ).toHaveLength(same ? 1 : 2);
      expect(imageRead).not.toHaveBeenCalled();
    },
  );

  it("retains each image position while later activities reuse their confirmed Reminder sources", async () => {
    const first = record(1, 4);
    const second = record(1, 5);
    const third = record(1, 6);
    if (!first.request || !second.request || !third.request)
      throw new Error("Missing request");
    const image: HistoryBinary = {
      kind: "binary",
      source: "related",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 0, "content", 0],
      media_type: "image/png",
      size: 3,
      identifier: "same",
    };
    const call = response([
      {
        part_kind: "tool-call",
        tool_name: "view_image",
        tool_call_id: "image",
        args: { path: "配图.png" },
      },
    ]);
    const result = {
      kind: "request",
      parts: [
        {
          part_kind: "tool-return",
          tool_name: "view_image",
          tool_call_id: "image",
          content: [image],
        },
      ],
    };
    first.request.response = page([call]);
    first.request.related = page([result]);
    const copied = { ...image, source: "input", message_index: 2 };
    second.request.input = page([
      ...first.request.input.messages,
      call,
      { ...result, parts: [{ ...result.parts[0], content: [copied] }] },
      {
        ...user(prompt),
        metadata: marker(
          [{ part_index: 0, kind: "reminder", source_id: "reminder-5" }],
          5,
        ),
      },
    ]);
    third.request.input = page([
      ...second.request.input.messages,
      ...(second.request.response?.messages ?? []),
      {
        ...user(prompt),
        metadata: marker(
          [{ part_index: 0, kind: "reminder", source_id: "reminder-6" }],
          6,
        ),
      },
    ]);
    const data = [
      await read([first]),
      await read([second]),
      await read([third]),
    ];
    const context = composeContext(2, data);
    expect(context.entries.filter((entry) => entry.reminder)).toHaveLength(3);
    expect(
      context.entries.find((entry) => entry.action)?.action?.results,
    ).toHaveLength(3);
    expect(context.missing).toEqual([]);
    expect(
      context.entries
        .filter((entry) => entry.reminder)
        .map((entry) => entry.contextSource?.sequence),
    ).toEqual([4, 5, 6]);
  });

  it("preserves a changed temporary prompt and later environment text at their original positions", async () => {
    const first = record(1);
    const second = record(2);
    if (!first.request || !second.request) throw new Error("Missing request");
    first.request.input.messages.push({
      ...user("附加说明甲"),
      metadata: marker([
        { part_index: 0, kind: "ephemeral", source_id: "temporary-one" },
      ]),
    });
    second.request.input.messages = [
      ...(record().request?.input.messages ?? []),
      ...(first.request.response?.messages ?? []),
      {
        ...user("附加说明乙"),
        metadata: marker([
          { part_index: 0, kind: "ephemeral", source_id: "temporary-two" },
        ]),
      },
    ];
    for (const item of [first, second]) {
      item.run = { ...item.run, request_count: 2 };
      item.requests = [first.requests[0], second.requests[0]];
    }
    const context = composeContext(2, [await read([first, second])]);
    expect(
      context.entries
        .map((entry) => entry.value.content)
        .filter(
          (value) => typeof value === "string" && value.startsWith("附加说明"),
        ),
    ).toEqual(["附加说明甲", "附加说明乙"]);
  });
});
