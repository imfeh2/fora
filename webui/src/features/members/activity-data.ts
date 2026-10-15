import {
  type AgentHistoryRead,
  type AgentHistoryRequestSummary,
  type AgentHistoryRun,
  backend,
  type HistoryBinary,
  type HistoryMessages,
  type HistoryReminder,
  type HistoryText,
  type HistoryValue,
  type LiveTool,
  type UsageVersion,
} from "@/lib/backend";

type Part = { [key: string]: HistoryValue };
export type TextPage = Awaited<ReturnType<typeof backend.agentHistoryText>>;
export type TextReads = Map<string, Promise<TextPage>>;
export type ActivityPart = {
  key: string;
  ordinal: number;
  messageIndex: number;
  partIndex: number;
  timestamp: string | null;
  saved?: boolean;
  value: Part;
};
export type ActivityAction = ActivityPart & {
  args: HistoryValue;
  results: ActivityPart[];
  sent: (HistoryReminder & { created_at: string }) | null;
  requestId?: string;
  observation?: {
    runtime_epoch: string;
    live_revision: number;
    request_id: string;
  };
  observationError?: string;
  readingObservation?: boolean;
  lifecycle?: Pick<
    LiveTool,
    | "status"
    | "started_at"
    | "completed_at"
    | "saved"
    | "has_result"
    | "content_version"
  >;
};
export type ActivityRequestSnapshot = {
  readId: AbortSignal;
  request: NonNullable<AgentHistoryRead["request"]>;
  parameters: HistoryValue;
  values: Partial<Record<"input" | "response" | "related", HistoryValue[]>>;
  complete: boolean;
};
export type ActivityData = {
  agentId: number;
  run: AgentHistoryRun;
  requests: AgentHistoryRequestSummary[];
  contents: Record<number, ActivityRequestSnapshot>;
  legacy: HistoryValue[];
  legacyBoundary: number | null;
  pending: number[];
  textValues: Record<string, HistoryText>;
  textReads: TextReads;
  complete: boolean;
  missing: string[];
  usageVersion?: UsageVersion;
  requestsComplete?: boolean;
};

export function clearLiveActivity(data: ActivityData): ActivityData {
  return {
    ...data,
    contents: Object.fromEntries(
      Object.entries(data.contents).map(([ordinal, snapshot]) => {
        const { request, values } = snapshot;
        const temporary = request.response_saved === false;
        return [
          ordinal,
          {
            ...snapshot,
            request: {
              ...request,
              observation: undefined,
              response: temporary ? null : request.response,
            },
            values: temporary ? { ...values, response: undefined } : values,
          },
        ];
      }),
    ),
  };
}

export function mergeActivityData(
  previous: ActivityData | null,
  incoming: ActivityData,
): ActivityData {
  if (!previous) return incoming;
  if (
    previous.agentId !== incoming.agentId ||
    previous.run.sequence !== incoming.run.sequence ||
    previous.run.window_number !== incoming.run.window_number
  )
    throw new Error("Saved activity snapshots do not share an identity");
  if (incoming.complete) return incoming;
  const retained =
    previous.usageVersion?.runtime_epoch !==
    incoming.usageVersion?.runtime_epoch
      ? clearLiveActivity(previous)
      : previous;
  const requests = [
    ...new Map(
      [...retained.requests, ...incoming.requests].map((request) => [
        request.ordinal,
        request,
      ]),
    ).values(),
  ]
    .filter((request) => request.ordinal <= incoming.run.request_count)
    .sort((left, right) => left.ordinal - right.ordinal);
  const contents: Record<number, ActivityRequestSnapshot> = {};
  const pending: number[] = [];
  for (const summary of requests) {
    const saved = retained.contents[summary.ordinal];
    const current = incoming.contents[summary.ordinal];
    if (!current?.complete) pending.push(summary.ordinal);
    const selected = saved && !current?.complete ? saved : current;
    if (selected) contents[summary.ordinal] = selected;
  }
  return {
    ...incoming,
    requests,
    contents,
    pending,
    legacy:
      incoming.run.request_count === 0 && !incoming.complete
        ? retained.legacy
        : incoming.legacy,
  };
}

export function activityRecord(value: HistoryValue): value is Part {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function activityText(value: HistoryValue): HistoryText | null {
  if (
    !activityRecord(value) ||
    value.kind !== "text" ||
    typeof value.source !== "string" ||
    ![
      "history",
      "run",
      "input",
      "response",
      "related",
      "parameters",
      "settings",
      "model",
      "live",
    ].includes(value.source) ||
    !Array.isArray(value.path) ||
    typeof value.message_index !== "number" ||
    Object.keys(value).some(
      (key) =>
        ![
          "kind",
          "source",
          "request_ordinal",
          "message_index",
          "path",
          "offset",
          "next_offset",
          "total_bytes",
          "value",
          "has_more",
          "runtime_epoch",
          "part_index",
          "content_source",
          "content_version",
        ].includes(key),
    )
  )
    return null;
  if (
    typeof value.value !== "string" ||
    typeof value.source !== "string" ||
    typeof value.message_index !== "number" ||
    !Array.isArray(value.path) ||
    typeof value.offset !== "number" ||
    typeof value.next_offset !== "number" ||
    typeof value.total_bytes !== "number" ||
    typeof value.has_more !== "boolean"
  )
    throw new Error("Saved text location is invalid");
  return value as unknown as HistoryText;
}

export function activityBinary(value: HistoryValue): HistoryBinary | null {
  if (
    !activityRecord(value) ||
    value.kind !== "binary" ||
    typeof value.source !== "string" ||
    !["run", "input", "response", "related", "live"].includes(value.source) ||
    !Array.isArray(value.path) ||
    typeof value.message_index !== "number" ||
    Object.keys(value).some(
      (key) =>
        ![
          "kind",
          "source",
          "request_ordinal",
          "message_index",
          "path",
          "media_type",
          "size",
          "identifier",
          "runtime_epoch",
          "part_index",
          "content_source",
          "content_version",
        ].includes(key),
    )
  )
    return null;
  if (typeof value.media_type !== "string" || typeof value.size !== "number")
    throw new Error("Saved binary location is invalid");
  return value as unknown as HistoryBinary;
}

export function savedTextKey(sequence: number, reference: HistoryText): string {
  return JSON.stringify([
    sequence,
    reference.source,
    reference.request_ordinal ?? 0,
    reference.message_index,
    reference.path,
    reference.runtime_epoch,
    reference.part_index,
    reference.content_source,
    reference.content_version,
  ]);
}

export async function readTextPage(
  agentId: number,
  sequence: number,
  reference: HistoryText,
  offset: number,
  reads?: TextReads,
): Promise<TextPage> {
  const key = JSON.stringify([
    savedTextKey(sequence, reference),
    offset,
    reference.total_bytes,
  ]);
  const pending =
    reads?.get(key) ??
    backend.agentHistoryText(agentId, sequence, { ...reference, offset });
  reads?.set(key, pending);
  try {
    return await pending;
  } finally {
    if (reads?.get(key) === pending) reads.delete(key);
  }
}

export async function completeText(
  agentId: number,
  sequence: number,
  value: HistoryValue,
  signal: AbortSignal,
  onText?: (text: HistoryText) => void,
  cache?: Record<string, HistoryText>,
  reads?: TextReads,
): Promise<HistoryValue> {
  const reference = activityText(value);
  if (!reference) return value;
  const key = savedTextKey(sequence, reference);
  const saved = cache?.[key];
  if (
    saved &&
    saved.total_bytes === reference.total_bytes &&
    saved.value.startsWith(reference.value) &&
    !saved.has_more
  )
    return saved.value;
  let text = reference.value;
  let offset = reference.next_offset;
  let more = reference.has_more;
  while (more) {
    signal.throwIfAborted();
    const page = await readTextPage(
      agentId,
      sequence,
      reference,
      offset,
      reads,
    );
    signal.throwIfAborted();
    if (page.offset !== offset || page.next_offset <= offset)
      throw new Error("Saved text did not advance");
    text += page.value;
    offset = page.next_offset;
    more = page.has_more;
    onText?.({
      ...reference,
      value: text,
      next_offset: offset,
      total_bytes: page.total_bytes,
      has_more: more,
    });
  }
  if (cache)
    cache[key] = {
      ...reference,
      value: text,
      next_offset: offset,
      has_more: false,
    };
  return text;
}

async function completeValue(
  agentId: number,
  sequence: number,
  value: HistoryValue,
  signal: AbortSignal,
  cache: Record<string, HistoryText>,
  reads: TextReads,
): Promise<HistoryValue> {
  signal.throwIfAborted();
  const text = activityText(value);
  if (text?.source === "live") return value;
  if (text)
    return completeText(
      agentId,
      sequence,
      value,
      signal,
      undefined,
      cache,
      reads,
    );
  if (Array.isArray(value)) {
    const children: HistoryValue[] = [];
    for (const child of value)
      children.push(
        await completeValue(agentId, sequence, child, signal, cache, reads),
      );
    return children;
  }
  if (!activityRecord(value) || activityBinary(value)) return value;
  const result: Record<string, HistoryValue> = {};
  for (const [key, child] of Object.entries(value))
    result[key] = await completeValue(
      agentId,
      sequence,
      child,
      signal,
      cache,
      reads,
    );
  return result;
}

export async function structuredValue(
  agentId: number,
  sequence: number,
  value: HistoryValue,
  signal: AbortSignal,
  onText?: (text: HistoryText) => void,
  cache?: Record<string, HistoryText>,
  reads?: TextReads,
): Promise<HistoryValue> {
  const complete = await completeText(
    agentId,
    sequence,
    value,
    signal,
    onText,
    cache,
    reads,
  );
  if (typeof complete !== "string")
    return completeValue(
      agentId,
      sequence,
      complete,
      signal,
      cache ?? {},
      reads ?? new Map(),
    );
  try {
    return JSON.parse(complete) as HistoryValue;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return complete;
  }
}

export async function readableResult(
  agentId: number,
  sequence: number,
  value: HistoryValue,
  signal: AbortSignal,
  onText?: (text: HistoryText) => void,
  cache?: Record<string, HistoryText>,
  reads?: TextReads,
): Promise<HistoryValue> {
  const complete = await completeText(
    agentId,
    sequence,
    value,
    signal,
    onText,
    cache,
    reads,
  );
  if (typeof complete !== "string") return complete;
  const content = complete.trimStart();
  if (content.startsWith("{") || content.startsWith("["))
    return JSON.parse(complete) as HistoryValue;
  return complete;
}

export function activityParts(
  content: HistoryMessages,
  ordinal: number,
  source: string,
): ActivityPart[] {
  return content.messages.flatMap((message, index) => {
    if (!activityRecord(message) || !Array.isArray(message.parts))
      throw new Error("Saved message is invalid");
    return message.parts.map((value, partIndex) => {
      if (!activityRecord(value))
        throw new Error("Saved message part is invalid");
      const messageIndex = content.offset + index;
      return {
        key: `${ordinal}:${source}:${messageIndex}:${partIndex}`,
        ordinal,
        messageIndex,
        partIndex,
        timestamp:
          typeof message.timestamp === "string" ? message.timestamp : null,
        saved: content.saved !== false,
        value,
      };
    });
  });
}

function mergeMessages(
  current: HistoryMessages,
  page: HistoryMessages,
): HistoryMessages {
  const messages = [...current.messages];
  for (const [index, value] of page.messages.entries()) {
    const position = page.offset + index - current.offset;
    if (position < 0 || position > messages.length)
      throw new Error("Saved message page has a gap");
    messages[position] = value;
  }
  const count = Math.min(messages.length, page.total - current.offset);
  const end = current.offset + count;
  return {
    ...page,
    offset: current.offset,
    messages: messages.slice(0, count),
    has_more: end < page.total,
    next_offset: end < page.total ? end : undefined,
  };
}

async function readLegacy(
  agentId: number,
  sequence: number,
  first: AgentHistoryRead,
  signal: AbortSignal,
): Promise<HistoryValue[]> {
  let page = first.messages;
  let text = "";
  while (true) {
    signal.throwIfAborted();
    for (const message of page.messages) {
      if (!activityRecord(message) || message.kind !== "legacy")
        throw new Error("Saved legacy history is invalid");
      if (typeof message.content !== "string")
        throw new Error("Saved legacy text is invalid");
      text += message.content;
    }
    if (!page.has_more) break;
    const offset = page.next_offset;
    if (offset === undefined || offset <= page.offset)
      throw new Error("Saved legacy history did not advance");
    const next = await backend.agentHistoryRead(
      agentId,
      sequence,
      undefined,
      offset,
    );
    signal.throwIfAborted();
    page = next.messages;
  }
  if (!text) return [];
  const messages = JSON.parse(text) as HistoryValue;
  if (!Array.isArray(messages))
    throw new Error("Saved legacy messages are invalid");
  return messages;
}

function legacyValue(
  value: HistoryValue,
  messageIndex: number,
  path: (string | number)[],
): HistoryValue {
  if (Array.isArray(value))
    return value.map((child, index) =>
      legacyValue(child, messageIndex, [...path, index]),
    );
  if (!activityRecord(value)) return value;
  if (value.kind === "binary" && typeof value.data === "string") {
    if (typeof value.media_type !== "string")
      throw new Error("Saved legacy image type is missing");
    return {
      kind: "binary",
      source: "run",
      message_index: messageIndex,
      path,
      media_type: value.media_type,
      size: atob(value.data).length,
      identifier:
        typeof value.identifier === "string" ? value.identifier : null,
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      legacyValue(child, messageIndex, [...path, key]),
    ]),
  );
}

export async function loadActivity(
  agentId: number,
  sequence: number,
  signal: AbortSignal,
  publish: (data: ActivityData) => void,
  textValues: Record<string, HistoryText> = {},
  textReads: TextReads = new Map(),
): Promise<ActivityData> {
  const first = structuredClone(
    await backend.agentHistoryRead(agentId, sequence),
  );
  signal.throwIfAborted();
  if (first.agent_id !== agentId || first.run.sequence !== sequence)
    throw new Error("Saved activity identity does not match");
  const data: ActivityData = {
    agentId,
    run: first.run,
    requests: [...first.requests],
    contents: {},
    legacy: [],
    legacyBoundary:
      first.windows.find((window) => window.number === first.run.window_number)
        ?.since_sequence ?? (sequence === 1 ? 1 : null),
    pending: first.requests.map((request) => request.ordinal),
    textValues,
    textReads,
    complete: false,
    missing: [...first.missing],
    usageVersion: first.usage_version,
    requestsComplete: !first.requests_has_more,
  };
  publish({ ...data });
  if (data.run.request_count === 0) {
    data.legacy = await readLegacy(agentId, sequence, first, signal);
    data.legacy = data.legacy.map((message, index) =>
      legacyValue(message, index, []),
    );
    data.complete = true;
    signal.throwIfAborted();
    publish({ ...data });
    return data;
  }
  let page = first;
  while (page.requests_has_more) {
    const after = page.requests_next_after;
    if (after === null || !Number.isSafeInteger(after) || after < 1)
      throw new Error("Saved request list did not advance");
    page = await backend.agentHistoryRead(
      agentId,
      sequence,
      undefined,
      0,
      0,
      0,
      0,
      { requestAfter: after },
    );
    signal.throwIfAborted();
    const known = new Set(data.requests.map((request) => request.ordinal));
    const additional = page.requests.filter(
      (request) => !known.has(request.ordinal),
    );
    if (!additional.length)
      throw new Error("Saved request list did not advance");
    data.requests = [...data.requests, ...additional];
    data.missing = [...data.missing, ...page.missing];
  }
  data.requestsComplete = true;
  data.requests = [...data.requests].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  if (data.requests.length !== data.run.request_count)
    throw new Error("Saved request list is incomplete");
  for (const summary of data.requests) {
    const read =
      first.request?.summary.ordinal === summary.ordinal
        ? first
        : await backend.agentHistoryRead(agentId, sequence, summary.ordinal);
    signal.throwIfAborted();
    if (!read.request || read.request.summary.ordinal !== summary.ordinal)
      throw new Error("Saved request content is missing");
    let request = structuredClone(read.request);
    data.missing = [...data.missing, ...read.missing];
    for (const source of ["input", "response", "related"] as const) {
      let content = request[source];
      while (content?.has_more) {
        const offset =
          content.next_offset ?? content.offset + content.messages.length;
        if (offset <= content.offset)
          throw new Error("Saved message list did not advance");
        const next = await backend.agentHistoryRead(
          agentId,
          sequence,
          summary.ordinal,
          0,
          source === "input" ? offset : 0,
          source === "response" ? offset : 0,
          source === "related" ? offset : 0,
        );
        signal.throwIfAborted();
        const incoming = next.request?.[source];
        if (
          !incoming ||
          incoming.offset !== offset ||
          !incoming.messages.length
        )
          throw new Error("Saved message page is missing");
        content = mergeMessages(content, incoming);
        request = { ...request, [source]: content };
        data.missing = [...data.missing, ...next.missing];
      }
    }
    const parameters = await structuredValue(
      agentId,
      sequence,
      request.parameters as unknown as HistoryValue,
      signal,
      undefined,
      data.textValues,
      data.textReads,
    );
    signal.throwIfAborted();
    let snapshot: ActivityRequestSnapshot = {
      readId: signal,
      request,
      parameters,
      values: {},
      complete: false,
    };
    data.contents = { ...data.contents, [summary.ordinal]: snapshot };
    data.pending = data.requests
      .filter((item) => !data.contents[item.ordinal]?.complete)
      .map((item) => item.ordinal);
    publish({ ...data });
    for (const source of ["input", "response", "related"] as const) {
      const content = request[source];
      if (!content) continue;
      const values: HistoryValue[] = [];
      for (const message of content.messages) {
        values.push(
          await completeValue(
            agentId,
            sequence,
            message,
            signal,
            data.textValues,
            data.textReads,
          ),
        );
      }
      snapshot = {
        ...snapshot,
        values: { ...snapshot.values, [source]: values },
      };
    }
    snapshot = { ...snapshot, complete: true };
    data.contents = { ...data.contents, [summary.ordinal]: snapshot };
    data.pending = data.requests
      .filter((item) => !data.contents[item.ordinal]?.complete)
      .map((item) => item.ordinal);
    publish({ ...data });
  }
  data.complete = true;
  data.missing = [...new Set(data.missing)];
  signal.throwIfAborted();
  publish({ ...data });
  return data;
}
