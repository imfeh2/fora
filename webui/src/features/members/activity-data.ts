import {
  type AgentHistoryRead,
  type AgentHistoryRequestSummary,
  type AgentHistoryRun,
  backend,
  type HistoryMessages,
  type HistoryReminder,
  type HistoryText,
  type HistoryValue,
} from "@/lib/backend";

type Part = { [key: string]: HistoryValue };
export type ActivityPart = {
  key: string;
  ordinal: number;
  messageIndex: number;
  partIndex: number;
  timestamp: string | null;
  value: Part;
};
export type ActivityAction = ActivityPart & {
  args: HistoryValue;
  results: ActivityPart[];
  sent: (HistoryReminder & { created_at: string }) | null;
};
export type ActivityData = {
  run: AgentHistoryRun;
  requests: AgentHistoryRequestSummary[];
  contents: Record<number, NonNullable<AgentHistoryRead["request"]>>;
  legacy: HistoryValue[];
  legacyStart: number;
  actions: ActivityAction[];
  notes: ActivityPart[];
  final: ActivityPart[];
  complete: boolean;
  missing: string[];
};

export function activityRecord(value: HistoryValue): value is Part {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function activityText(value: HistoryValue): HistoryText | null {
  if (!activityRecord(value) || value.kind !== "text") return null;
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

async function completeText(
  agentId: number,
  sequence: number,
  value: HistoryValue,
  signal: AbortSignal,
  onText?: (text: HistoryText) => void,
): Promise<HistoryValue> {
  const reference = activityText(value);
  if (!reference) return value;
  let text = reference.value;
  let offset = reference.next_offset;
  let more = reference.has_more;
  while (more) {
    signal.throwIfAborted();
    const page = await backend.agentHistoryText(agentId, sequence, {
      ...reference,
      offset,
    });
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
  return text;
}

export async function structuredValue(
  agentId: number,
  sequence: number,
  value: HistoryValue,
  signal: AbortSignal,
  onText?: (text: HistoryText) => void,
): Promise<HistoryValue> {
  const complete = await completeText(agentId, sequence, value, signal, onText);
  if (typeof complete !== "string") return complete;
  return JSON.parse(complete) as HistoryValue;
}

export async function readableResult(
  agentId: number,
  sequence: number,
  value: HistoryValue,
  signal: AbortSignal,
  onText?: (text: HistoryText) => void,
): Promise<HistoryValue> {
  const complete = await completeText(agentId, sequence, value, signal, onText);
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

async function collectActivity(
  agentId: number,
  data: ActivityData,
  signal: AbortSignal,
  parsed: Map<string, HistoryValue>,
): Promise<ActivityData> {
  const actions: ActivityAction[] = [];
  const notes: ActivityPart[] = [];
  const responses: ActivityPart[][] = [];
  const groups = data.requests.length
    ? data.requests.map((summary) => {
        const content = data.contents[summary.ordinal];
        return {
          parts: content?.response
            ? activityParts(content.response, summary.ordinal, "response")
            : [],
          results: content
            ? activityParts(content.related, summary.ordinal, "related")
            : [],
        };
      })
    : [
        {
          parts: activityParts(
            {
              messages: data.legacy.slice(data.legacyStart),
              offset: data.legacyStart,
              total: data.legacy.length,
              has_more: false,
            },
            0,
            "run",
          ),
          results: activityParts(
            {
              messages: data.legacy.slice(data.legacyStart),
              offset: data.legacyStart,
              total: data.legacy.length,
              has_more: false,
            },
            0,
            "run",
          ),
        },
      ];
  for (const group of groups) {
    const texts = group.parts.filter((part) => part.value.part_kind === "text");
    if (texts.length) responses.push(texts);
    for (const part of group.parts) {
      const value = part.value;
      if (value.part_kind === "thinking") notes.push(part);
      if (value.part_kind !== "tool-call") continue;
      let args = parsed.get(`${part.key}:args`);
      if (args === undefined) {
        args = await structuredValue(
          agentId,
          data.run.sequence,
          value.args,
          signal,
        );
        parsed.set(`${part.key}:args`, args);
      }
      const nextCall =
        part.ordinal === 0
          ? group.parts.find(
              (candidate) =>
                candidate.messageIndex > part.messageIndex &&
                candidate.value.part_kind === "tool-call" &&
                candidate.value.tool_call_id === value.tool_call_id,
            )
          : undefined;
      const results = group.results.filter(
        (result) =>
          (result.value.part_kind === "tool-return" ||
            result.value.part_kind === "retry-prompt") &&
          typeof value.tool_call_id === "string" &&
          result.value.tool_call_id === value.tool_call_id &&
          (part.ordinal !== 0 ||
            (result.messageIndex > part.messageIndex &&
              (!nextCall || result.messageIndex < nextCall.messageIndex))),
      );
      let sent: ActivityAction["sent"] = null;
      if (
        value.tool_name === "discussion" &&
        activityRecord(args) &&
        args.action === "send"
      ) {
        for (const result of results) {
          if (result.value.part_kind !== "tool-return") continue;
          let content = parsed.get(`${result.key}:content`);
          if (content === undefined) {
            content = await structuredValue(
              agentId,
              data.run.sequence,
              result.value.content,
              signal,
            );
            parsed.set(`${result.key}:content`, content);
          }
          if (
            activityRecord(content) &&
            content.error === undefined &&
            typeof content.discussion_id === "number" &&
            Number.isSafeInteger(content.discussion_id) &&
            content.discussion_id > 0 &&
            typeof content.id === "number" &&
            Number.isSafeInteger(content.id) &&
            content.id > 0 &&
            typeof content.created_at === "string"
          ) {
            sent = {
              discussion_id: content.discussion_id,
              message_id: content.id,
              created_at: content.created_at,
            };
          }
        }
      }
      actions.push({ ...part, args, results, sent });
    }
    const linked = new Set(
      actions.flatMap((action) => action.results.map((result) => result.key)),
    );
    for (const result of group.results) {
      if (
        (result.value.part_kind === "tool-return" ||
          result.value.part_kind === "retry-prompt") &&
        !linked.has(result.key)
      ) {
        actions.push({ ...result, args: null, results: [result], sent: null });
        data.missing = [
          ...new Set([
            ...data.missing,
            "A saved tool result has no matching action",
          ]),
        ];
      }
    }
  }
  const sent = actions.some((action) => action.sent !== null);
  const lastGroup = groups[groups.length - 1];
  const modelParts =
    lastGroup?.parts.filter((part) =>
      ["text", "thinking", "tool-call"].includes(String(part.value.part_kind)),
    ) ?? [];
  const lastMessage = modelParts[modelParts.length - 1]?.messageIndex;
  const ending =
    lastGroup &&
    !modelParts.some(
      (part) =>
        part.messageIndex === lastMessage &&
        part.value.part_kind === "tool-call",
    )
      ? modelParts.filter(
          (part) =>
            part.messageIndex === lastMessage &&
            part.value.part_kind === "text",
        )
      : [];
  const final =
    data.complete &&
    !sent &&
    !data.missing.length &&
    data.run.status === "completed"
      ? ending
      : [];
  const excluded = new Set((sent ? ending : final).map((part) => part.key));
  for (const parts of responses)
    for (const part of parts) if (!excluded.has(part.key)) notes.push(part);
  return { ...data, actions, notes, final };
}

export async function loadActivity(
  agentId: number,
  sequence: number,
  signal: AbortSignal,
  publish: (data: ActivityData) => void,
): Promise<ActivityData> {
  const parsed = new Map<string, HistoryValue>();
  const first = await backend.agentHistoryRead(agentId, sequence);
  signal.throwIfAborted();
  if (first.agent_id !== agentId || first.run.sequence !== sequence)
    throw new Error("Saved activity identity does not match");
  if (first.run.reminded === undefined)
    throw new Error("Saved trigger information is unavailable");
  const data: ActivityData = {
    run: first.run,
    requests: [...first.requests],
    contents: {},
    legacy: [],
    legacyStart: 0,
    actions: [],
    notes: [],
    final: [],
    complete: false,
    missing: [...first.missing],
  };
  publish({ ...data });
  if (data.run.request_count === 0) {
    data.legacy = await readLegacy(agentId, sequence, first, signal);
    if (
      data.run.window_number !== null &&
      data.run.window_number > 0 &&
      data.legacy.length
    ) {
      const prior = await backend.agentHistory(agentId, sequence, 1);
      signal.throwIfAborted();
      const previous = prior.runs[0];
      const window = first.windows.find(
        (event) => event.number === data.run.window_number,
      );
      if (
        !previous &&
        sequence > 1 &&
        (!window || window.since_sequence < sequence)
      )
        throw new Error("The preceding saved history is unavailable");
      if (previous && previous.window_number === data.run.window_number) {
        if (previous.sequence + 1 !== sequence)
          throw new Error("The adjacent saved history is unavailable");
        if (previous.request_count !== 0)
          throw new Error(
            "Saved legacy history has no comparable preceding snapshot",
          );
        const previousRead = await backend.agentHistoryRead(
          agentId,
          previous.sequence,
        );
        signal.throwIfAborted();
        const messages = await readLegacy(
          agentId,
          previous.sequence,
          previousRead,
          signal,
        );
        if (previousRead.missing.length || messages.length > data.legacy.length)
          throw new Error("Saved legacy history is incomplete");
        for (const [index, message] of messages.entries()) {
          if (JSON.stringify(message) !== JSON.stringify(data.legacy[index]))
            throw new Error(
              "Saved legacy history has no matching preceding prefix",
            );
        }
        data.legacyStart = messages.length;
      }
    }
    data.legacy = data.legacy.map((message, index) =>
      legacyValue(message, index, []),
    );
    data.complete = true;
    const result = await collectActivity(agentId, data, signal, parsed);
    signal.throwIfAborted();
    publish(result);
    return result;
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
    data.requests.push(...additional);
    data.missing.push(...page.missing);
  }
  data.requests.sort((left, right) => left.ordinal - right.ordinal);
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
    let request = read.request;
    data.missing.push(...read.missing);
    for (const source of ["response", "related"] as const) {
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
          0,
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
        data.missing.push(...next.missing);
      }
    }
    data.contents = { ...data.contents, [summary.ordinal]: request };
    const progress = await collectActivity(agentId, data, signal, parsed);
    signal.throwIfAborted();
    publish(progress);
  }
  data.complete = true;
  data.missing = [...new Set(data.missing)];
  const result = await collectActivity(agentId, data, signal, parsed);
  signal.throwIfAborted();
  publish(result);
  return result;
}
