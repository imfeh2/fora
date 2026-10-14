import {
  type ActivityAction,
  type ActivityData,
  type ActivityPart,
  activityBinary,
  activityRecord,
  activityText,
} from "@/features/members/activity-data";
import type {
  GenerationPart,
  HistoryBinary,
  HistoryImage,
  HistoryValue,
  LiveTool,
} from "@/lib/backend";

type Part = Record<string, HistoryValue>;
type ContextSource = {
  part_index: number;
  kind:
    | "session_context"
    | "reminder"
    | "preparation"
    | "environment"
    | "ephemeral";
  source_id: string;
  agent_id: number;
  sequence: number;
};
export type ContextLocation = {
  agentId: number;
  windowNumber: number | null;
  sequence: number;
  ordinal: number;
  source: string;
  messageIndex: number;
  path: (string | number)[];
};
export type ContextEntry = ActivityPart & {
  sequence: number;
  source: string;
  location: ContextLocation;
  references: ContextLocation[];
  canonical: Part;
  contentIdentity: string;
  resolved: Part;
  messageIdentity: string;
  contextSource: ContextSource | null;
  title: string | null;
  reminder: boolean;
  action?: ActivityAction;
  reply?: string;
  replyPosition?: string;
  workRecord: boolean;
  diagnostic?: string;
  generation?: GenerationPart;
};
export type ContextCoverage = {
  location: ContextLocation;
  target: string;
  kind: "content" | "reference" | "inspection";
};
export type ContextComposition = {
  entries: ContextEntry[];
  coverage: ContextCoverage[];
  missing: string[];
};

export function contextLocationKey(location: ContextLocation): string {
  return JSON.stringify([
    location.agentId,
    location.windowNumber,
    location.sequence,
    location.ordinal,
    location.source,
    location.messageIndex,
    location.path,
  ]);
}

export function contextImageKey(
  sequence: number,
  image: HistoryBinary,
): string {
  return JSON.stringify([
    sequence,
    image.request_ordinal ?? 0,
    image.source,
    image.message_index,
    image.path,
    image.runtime_epoch,
    image.part_index,
    image.content_source,
    image.content_version,
  ]);
}

function comparable(
  value: HistoryValue,
  sequence: number,
  images: Record<string, HistoryImage>,
): HistoryValue {
  if (activityText(value)) return { unread: value };
  if (Array.isArray(value))
    return value.map((child) => comparable(child, sequence, images));
  if (!activityRecord(value)) return value;
  const image = activityBinary(value);
  if (image) {
    const saved = images[contextImageKey(sequence, image)];
    return saved
      ? { kind: "binary", media_type: saved.media_type, data: saved.data }
      : { unread: contextImageKey(sequence, image) };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      comparable(child, sequence, images),
    ]),
  );
}

function imageStructure(value: HistoryValue): {
  value: HistoryValue;
  images: number;
} {
  const binary = activityBinary(value);
  if (binary)
    return {
      value: { kind: "binary", media_type: binary.media_type },
      images: 1,
    };
  if (Array.isArray(value)) {
    const children = value.map(imageStructure);
    return {
      value: children.map((child) => child.value),
      images: children.reduce((count, child) => count + child.images, 0),
    };
  }
  if (!activityRecord(value)) return { value, images: 0 };
  const children = Object.entries(value).map(
    ([key, child]) => [key, imageStructure(child)] as const,
  );
  return {
    value: Object.fromEntries(
      children.map(([key, child]) => [key, child.value]),
    ),
    images: children.reduce((count, [, child]) => count + child.images, 0),
  };
}

function sameSource(left: ContextEntry, right: ContextEntry): boolean {
  return (
    left.saved !== false &&
    right.saved !== false &&
    left.messageIdentity === right.messageIdentity &&
    JSON.stringify(
      left.contextSource && { ...left.contextSource, part_index: 0 },
    ) ===
      JSON.stringify(
        right.contextSource && { ...right.contextSource, part_index: 0 },
      )
  );
}

function sameEntry(left: ContextEntry, right: ContextEntry): boolean {
  return (
    sameSource(left, right) && left.contentIdentity === right.contentIdentity
  );
}

function locations(
  value: HistoryValue,
  location: ContextLocation,
): ContextLocation[] {
  if (activityText(value) || activityBinary(value)) return [location];
  if (Array.isArray(value))
    return value.length
      ? value.flatMap((child, index) =>
          locations(child, { ...location, path: [...location.path, index] }),
        )
      : [location];
  if (activityRecord(value)) {
    const fields = Object.entries(value);
    return fields.length
      ? fields.flatMap(([key, child]) =>
          locations(child, { ...location, path: [...location.path, key] }),
        )
      : [location];
  }
  return [location];
}

function partSources(
  message: Part,
  agentId: number,
  sequence: number,
): { parts: Map<number, ContextSource>; diagnostic?: string } {
  const metadata = activityRecord(message.metadata) ? message.metadata : {};
  const fora = activityRecord(metadata.fora) ? metadata.fora : {};
  const raw = fora.context_sources;
  const parts = new Map<number, ContextSource>();
  if (raw === undefined) return { parts };
  const invalid = () => ({
    parts: new Map<number, ContextSource>(),
    diagnostic: "Saved context source metadata is invalid or unsupported",
  });
  if (
    !activityRecord(raw) ||
    raw.version !== 1 ||
    !Array.isArray(raw.parts) ||
    typeof raw.metadata_was_none !== "boolean" ||
    typeof raw.fora_was_missing !== "boolean" ||
    Object.keys(raw).some(
      (key) =>
        !["version", "metadata_was_none", "fora_was_missing", "parts"].includes(
          key,
        ),
    ) ||
    !Array.isArray(message.parts)
  )
    return invalid();
  for (const value of raw.parts) {
    if (
      !activityRecord(value) ||
      typeof value.part_index !== "number" ||
      !Number.isSafeInteger(value.part_index) ||
      value.part_index < 0 ||
      value.part_index >= message.parts.length ||
      parts.has(value.part_index) ||
      typeof value.kind !== "string" ||
      ![
        "session_context",
        "reminder",
        "preparation",
        "environment",
        "ephemeral",
      ].includes(value.kind) ||
      typeof value.source_id !== "string" ||
      !value.source_id ||
      Object.keys(value).some(
        (key) =>
          !["part_index", "kind", "source_id", "agent_id", "sequence"].includes(
            key,
          ),
      ) ||
      value.agent_id !== agentId ||
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence <= 0 ||
      value.sequence > sequence
    )
      return invalid();
    const part = message.parts[value.part_index];
    if (!activityRecord(part) || part.part_kind !== "user-prompt")
      return invalid();
    const source: ContextSource = {
      part_index: value.part_index,
      kind: value.kind as ContextSource["kind"],
      source_id: value.source_id,
      agent_id: agentId,
      sequence: value.sequence,
    };
    parts.set(source.part_index, source);
  }
  return { parts };
}

export function composeContext(
  agentId: number,
  activities: ActivityData[],
  images: Record<string, HistoryImage> = {},
  identities: Map<string, string> = new Map(),
  generations: GenerationPart[] = [],
): ContextComposition {
  const entries: ContextEntry[] = [];
  const coverage: ContextCoverage[] = [];
  const missing: string[] = [];
  const savedIdentities = new Map(identities);
  const associations = new Map<string, ContextEntry>();
  let previous: ContextEntry[] = [];
  let previousWindow: number | null | undefined;
  let previousSequence: number | undefined;
  let previousInstructions = new Map<string, ContextEntry>();
  const addCoverage = (
    value: HistoryValue,
    location: ContextLocation,
    target: string,
    kind: ContextCoverage["kind"],
  ) => {
    for (const leaf of locations(value, location))
      coverage.push({ location: leaf, target, kind });
  };
  const addPartCoverage = (
    value: Part,
    location: ContextLocation,
    target: string,
    kind: ContextCoverage["kind"],
  ) => {
    const contentPart = [
      "text",
      "thinking",
      "user-prompt",
      "system-prompt",
    ].includes(String(value.part_kind));
    if (!contentPart) {
      addCoverage(value, location, target, kind);
      return;
    }
    for (const [field, child] of Object.entries(value)) {
      if (field === "content" && value.part_kind === "system-prompt") continue;
      addCoverage(
        child,
        { ...location, path: [...location.path, field] },
        field === "content" ? target : "Full context",
        field === "content" ? kind : "inspection",
      );
    }
  };
  for (const data of [...activities].sort(
    (left, right) => left.run.sequence - right.run.sequence,
  )) {
    const run = data.run;
    if (
      previousWindow !== run.window_number ||
      (previousSequence !== undefined && previousSequence + 1 !== run.sequence)
    ) {
      previous = [];
      previousInstructions = new Map();
    }
    previousWindow = run.window_number;
    previousSequence = run.sequence;
    missing.push(...data.missing);
    if (
      run.request_count === 0 &&
      data.legacy.length > 0 &&
      previous.length === 0 &&
      run.sequence > (data.legacyBoundary ?? 1)
    )
      missing.push("The preceding saved history has not been loaded");

    const base = {
      agentId,
      windowNumber: run.window_number,
      sequence: run.sequence,
    };
    const summaries = data.requests.length
      ? data.requests
      : [{ ordinal: 0, started_at: run.started_at }];
    for (const summary of summaries) {
      const snapshot = data.contents[summary.ordinal];
      const content = snapshot?.request;
      if (!content && summary.ordinal !== 0) continue;
      const ordinal = summary.ordinal;
      const instructionEntries = new Map<string, ContextEntry>();
      const addInstruction = (
        value: HistoryValue,
        location: ContextLocation,
      ) => {
        const signature = JSON.stringify(value);
        const existing =
          instructionEntries.get(signature) ??
          previousInstructions.get(signature);
        const originalKey = contextLocationKey(location);
        if (existing) {
          existing.references.push(location);
          addCoverage(value, location, existing.key, "reference");
          instructionEntries.set(signature, existing);
          return;
        }
        const entry: ContextEntry = {
          key: originalKey,
          ...base,
          ordinal,
          source: location.source,
          messageIndex: location.messageIndex,
          partIndex: -1,
          timestamp: summary.started_at,
          value: { part_kind: "system-prompt", content: value },
          canonical: { part_kind: "system-prompt", content: value },
          contentIdentity: JSON.stringify({
            part_kind: "system-prompt",
            content: value,
          }),
          resolved: { part_kind: "system-prompt", content: value },
          messageIdentity: "instructions",
          contextSource: null,
          location,
          references: [location],
          title: "Instructions",
          reminder: false,
          workRecord: false,
        };
        entries.push(entry);
        instructionEntries.set(signature, entry);
        addCoverage(value, location, entry.key, "content");
      };
      const parameters = snapshot?.parameters;
      if (activityRecord(parameters)) {
        for (const [key, value] of Object.entries(parameters)) {
          const location = {
            ...base,
            ordinal,
            source: "parameters",
            messageIndex: 0,
            path: [key],
          };
          if (key === "instruction_parts" && Array.isArray(value)) {
            for (const [index, part] of value.entries()) {
              if (activityRecord(part) && part.content !== undefined) {
                addInstruction(part.content, {
                  ...location,
                  path: [key, index, "content"],
                });
                for (const [field, child] of Object.entries(part))
                  if (field !== "content")
                    addCoverage(
                      child,
                      { ...location, path: [key, index, field] },
                      "Full context",
                      "inspection",
                    );
              } else
                addCoverage(
                  part,
                  { ...location, path: [key, index] },
                  "Full context",
                  "inspection",
                );
            }
            if (!value.length)
              addCoverage(value, location, "Full context", "inspection");
          } else addCoverage(value, location, "Full context", "inspection");
        }
      } else if (parameters !== undefined) {
        addCoverage(
          parameters,
          { ...base, ordinal, source: "parameters", messageIndex: 0, path: [] },
          "Full context",
          "inspection",
        );
        missing.push("Saved request parameters are not a structured object");
      }
      for (const source of ["settings", "model"] as const)
        if (content)
          addCoverage(
            content[source] as unknown as HistoryValue,
            { ...base, ordinal, source, messageIndex: 0, path: [] },
            "Full context",
            "inspection",
          );
      const input: ContextEntry[] = [];
      const added: ContextEntry[] = [];
      const scopeCalls = new Map<string, ContextEntry>();
      let pointer = 0;
      let matching = previous.length > 0;
      for (const source of ["input", "response", "related", "run"] as const) {
        const messages =
          source === "run"
            ? ordinal === 0
              ? data.legacy
              : []
            : (content?.[source]?.messages ?? []);
        const offset = source === "run" ? 0 : (content?.[source]?.offset ?? 0);
        const complete =
          source === "run" ? undefined : snapshot?.values[source];
        for (const [index, rawMessage] of messages.entries()) {
          if (!activityRecord(rawMessage) || !Array.isArray(rawMessage.parts))
            throw new Error("Saved context message is invalid");
          const messageIndex = offset + index;
          if (Array.isArray(complete) && complete.length !== messages.length)
            throw new Error(
              "Saved complete context does not match its message page",
            );
          const normalized = Array.isArray(complete)
            ? complete[index]
            : rawMessage;
          if (!activityRecord(normalized) || !Array.isArray(normalized.parts))
            throw new Error("Saved complete context message is invalid");
          const metadata = activityRecord(rawMessage.metadata)
            ? rawMessage.metadata
            : {};
          const fora = activityRecord(metadata.fora) ? metadata.fora : {};
          const messageLocation = {
            ...base,
            ordinal,
            source,
            messageIndex,
            path: [],
          };
          for (const [key, value] of Object.entries(rawMessage)) {
            if (key === "parts") continue;
            if (key === "instructions" && value !== null)
              addInstruction(normalized.instructions ?? value, {
                ...messageLocation,
                path: [key],
              });
            else
              addCoverage(
                value,
                { ...messageLocation, path: [key] },
                "Full context",
                "inspection",
              );
          }
          if (!rawMessage.parts.length)
            addCoverage(
              [],
              { ...messageLocation, path: ["parts"] },
              "Full context",
              "inspection",
            );
          const messageIdentity = JSON.stringify([rawMessage.kind]);
          const sources = partSources(normalized, agentId, run.sequence);
          if (sources.diagnostic) missing.push(sources.diagnostic);
          for (const [partIndex, value] of rawMessage.parts.entries()) {
            if (!activityRecord(value))
              throw new Error("Saved context part is invalid");
            const canonical = normalized.parts[partIndex];
            if (!activityRecord(canonical))
              throw new Error("Saved complete context part is invalid");
            const location = {
              ...messageLocation,
              path: ["parts", partIndex],
            };
            const originalKey = contextLocationKey(location);
            const contextSource = sources.parts.get(partIndex) ?? null;
            const isPrompt = contextSource?.kind === "reminder";
            const originalRun = isPrompt
              ? activities.find(
                  (activity) =>
                    activity.run.sequence === contextSource.sequence,
                )?.run
              : null;
            const legacyBlock =
              !sources.diagnostic &&
              fora.context_sources === undefined &&
              rawMessage.parts.length === 1
                ? fora.block
                : null;
            const unknownSource =
              value.part_kind === "user-prompt" &&
              !contextSource &&
              !["resident", "durable"].includes(String(legacyBlock));
            if (unknownSource)
              missing.push("The saved context source could not be confirmed");
            if (isPrompt && !originalRun)
              missing.push("The original reminder start time is unavailable");
            const compared = comparable(
              canonical,
              run.sequence,
              images,
            ) as Part;
            const entry: ContextEntry = {
              ...base,
              key: originalKey,
              ordinal,
              source,
              messageIndex,
              partIndex,
              saved: source === "run" || content?.[source]?.saved !== false,
              timestamp: isPrompt
                ? (originalRun?.started_at ?? null)
                : typeof value.timestamp === "string"
                  ? value.timestamp
                  : typeof rawMessage.timestamp === "string"
                    ? rawMessage.timestamp
                    : summary.started_at,
              value,
              canonical: compared,
              contentIdentity: JSON.stringify(compared),
              resolved: canonical,
              messageIdentity,
              contextSource,
              location,
              references: [location],
              title:
                value.part_kind === "system-prompt"
                  ? "Instructions"
                  : contextSource?.kind === "session_context" ||
                      legacyBlock === "resident"
                    ? "Session context"
                    : contextSource?.kind === "environment" ||
                        legacyBlock === "durable"
                      ? "Environment"
                      : value.part_kind === "user-prompt" && !isPrompt
                        ? "Context"
                        : null,
              reminder: isPrompt,
              workRecord:
                value.part_kind === "text" &&
                !rawMessage.parts.some(
                  (part) =>
                    activityRecord(part) && part.part_kind === "tool-call",
                ),
            };
            let existing: ContextEntry | undefined;
            if ((source === "input" || source === "run") && matching) {
              while (
                previous[pointer]?.contextSource?.kind === "ephemeral" &&
                !sameEntry(previous[pointer], entry)
              )
                pointer += 1;
              const found =
                previous[pointer] && sameEntry(previous[pointer], entry)
                  ? pointer
                  : -1;
              if (found >= 0) {
                existing = entries.find(
                  (candidate) => candidate.key === previous[found].key,
                );
                pointer = found + 1;
              } else {
                const adjacent = previous[pointer];
                const left = adjacent && imageStructure(adjacent.resolved);
                const right = imageStructure(entry.resolved);
                if (
                  adjacent &&
                  sameSource(adjacent, entry) &&
                  left &&
                  left.images > 0 &&
                  left.images === right.images &&
                  JSON.stringify(left.value) === JSON.stringify(right.value)
                )
                  pointer += 1;
                else matching = false;
              }
            }
            if (value.part_kind === "system-prompt") {
              addInstruction(canonical.content, {
                ...location,
                path: [...location.path, "content"],
              });
              existing = instructionEntries.get(
                JSON.stringify(canonical.content),
              );
            }
            const selected = existing ?? entry;
            const callId = value.tool_call_id;
            if (typeof callId === "string") {
              if (value.part_kind === "tool-call")
                scopeCalls.set(callId, selected);
              if (
                value.part_kind === "tool-return" ||
                value.part_kind === "retry-prompt"
              ) {
                const call = scopeCalls.get(callId);
                if (call) associations.set(selected.key, call);
              }
            }
            if (existing) {
              if (
                !existing.references.some(
                  (reference) => contextLocationKey(reference) === originalKey,
                )
              )
                existing.references.push(location);
              addPartCoverage(value, location, existing.key, "reference");
              if (source === "input" || source === "run")
                input.push({
                  ...entry,
                  key: existing.key,
                  references: existing.references,
                });
            } else {
              entries.push(entry);
              addPartCoverage(value, location, entry.key, "content");
              if (source === "input" || source === "run") input.push(entry);
              else added.push(entry);
            }
          }
        }
      }
      if (ordinal === 0 && previous.length > 0 && pointer < previous.length)
        missing.push("Saved legacy history has no matching preceding prefix");
      if (content || ordinal === 0) previous = [...input, ...added];
      previousInstructions = instructionEntries;
    }
  }
  for (const part of generations) {
    const key = part.key;
    const data = activities.find(
      (activity) => activity.run.sequence === key.sequence,
    );
    const summary = data?.requests.find(
      (request) => request.ordinal === key.ordinal,
    );
    if (
      !data ||
      !summary ||
      key.agent_id !== agentId ||
      key.request_id !== summary.request_id ||
      key.run_id !== summary.run_id
    )
      continue;
    const snapshot = data.contents[key.ordinal];
    const response = snapshot?.request.response;
    if (
      response &&
      snapshot?.request.response_saved !== false &&
      response.messages.length > 0
    )
      continue;
    if (!["text", "thinking", "tool-call"].includes(part.part_kind)) continue;
    const location: ContextLocation = {
      agentId,
      windowNumber: data.run.window_number,
      sequence: key.sequence,
      ordinal: key.ordinal,
      source: "response",
      messageIndex: 0,
      path: ["parts", key.part_index],
    };
    const originalKey = contextLocationKey(location);
    const reference = {
      kind: "generation",
      key: key as unknown as HistoryValue,
      revision: part.revision,
    };
    if (
      part.part_kind === "tool-call" &&
      (typeof part.tool_name !== "string" ||
        typeof part.tool_call_id !== "string")
    )
      throw new Error("Generated tool identity is unavailable");
    const value: Part =
      part.part_kind === "tool-call"
        ? {
            part_kind: part.part_kind,
            tool_name: part.tool_name as string,
            tool_call_id: part.tool_call_id as string,
            args: { ...reference, field: "args" },
          }
        : {
            part_kind: part.part_kind,
            content: { ...reference, field: "content" },
          };
    const existing = entries.find(
      (entry) =>
        entry.sequence === key.sequence &&
        entry.ordinal === key.ordinal &&
        entry.source === "response" &&
        entry.messageIndex === 0 &&
        entry.partIndex === key.part_index,
    );
    if (existing) {
      existing.generation = part;
      continue;
    }
    const position = entries.findIndex(
      (entry) =>
        entry.sequence > key.sequence ||
        (entry.sequence === key.sequence && entry.ordinal > key.ordinal),
    );
    entries.splice(position < 0 ? entries.length : position, 0, {
      key: originalKey,
      sequence: key.sequence,
      ordinal: key.ordinal,
      source: "response",
      messageIndex: 0,
      partIndex: key.part_index,
      timestamp: part.created_at,
      value,
      location,
      references: [location],
      canonical: value,
      contentIdentity: JSON.stringify(value),
      resolved: value,
      messageIdentity: JSON.stringify(["response"]),
      contextSource: null,
      title: null,
      reminder: false,
      workRecord: false,
      generation: part,
    });
  }
  const renamed = new Map<string, string>();
  const used = new Set<string>();
  for (const entry of entries) {
    const saved = entry.references
      .map((reference) => savedIdentities.get(contextLocationKey(reference)))
      .find((key) => key !== undefined && !used.has(key));
    const key = saved ?? entry.key;
    renamed.set(entry.key, key);
    entry.key = key;
    used.add(key);
    for (const reference of entry.references)
      identities.set(contextLocationKey(reference), key);
  }
  const targets = new Map<string, string>();
  const workReferences = new Set<string>();
  const structured = (
    entry: ContextEntry,
    value: HistoryValue,
  ): HistoryValue => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as HistoryValue;
    } catch (error) {
      entry.diagnostic = error instanceof Error ? error.message : String(error);
      return value;
    }
  };
  for (const entry of entries) {
    const value = entry.value;
    const kind = value.part_kind;
    if (kind === "tool-call") {
      const args = structured(entry, entry.resolved.args ?? value.args);
      entry.action = { ...entry, args, results: [], sent: null };
    } else if (kind === "tool-return" || kind === "retry-prompt") {
      const original = [...renamed].find(([, key]) => key === entry.key)?.[0];
      const call = original ? associations.get(original) : undefined;
      if (call?.action) {
        call.action.results.push(entry);
        targets.set(entry.key, call.key);
      } else if (kind === "tool-return") {
        missing.push("A saved tool result has no matching action");
      }
    }
  }
  const toolHidden = new Set<string>();
  for (const entry of entries) {
    const action = entry.action;
    if (!action) continue;
    const data = activities.find(
      (activity) => activity.run.sequence === entry.sequence,
    );
    const request = data?.contents[entry.ordinal]?.request;
    action.requestId =
      request?.summary.request_id ?? entry.generation?.key.request_id;
    action.observation = request?.observation;
    const observations =
      request?.related.messages.flatMap((message) => {
        if (!activityRecord(message) || !activityRecord(message.metadata))
          return [];
        const fora = message.metadata.fora;
        if (!activityRecord(fora) || !Array.isArray(fora.tool_observations))
          return [];
        if (
          fora.request_ordinal !== entry.ordinal ||
          fora.request_id !== request.summary.request_id
        )
          throw new Error("Saved tool observation request does not match");
        return fora.tool_observations;
      }) ?? [];
    const observation = observations.find(
      (item) => activityRecord(item) && item.part_index === entry.partIndex,
    );
    if (observation !== undefined) {
      if (
        !activityRecord(observation) ||
        observation.request_ordinal !== entry.ordinal ||
        observation.tool_call_id !== action.value.tool_call_id ||
        observation.tool_name !== action.value.tool_name ||
        !["queued", "running", "completed", "failed", "cancelled"].includes(
          String(observation.status),
        ) ||
        !(
          observation.started_at === null ||
          typeof observation.started_at === "string"
        ) ||
        !(
          observation.completed_at === null ||
          typeof observation.completed_at === "string"
        )
      )
        throw new Error("Saved tool observation identity is invalid");
      const associatedResults = action.results;
      if (Array.isArray(observation.result_positions)) {
        action.results = observation.result_positions.map((position) => {
          if (
            !Array.isArray(position) ||
            position.length !== 2 ||
            !position.every(
              (number) =>
                typeof number === "number" &&
                Number.isSafeInteger(number) &&
                number >= 0,
            )
          )
            throw new Error("Saved result position is invalid");
          const result = entries.find((candidate) =>
            candidate.references.some(
              (reference) =>
                reference.sequence === entry.sequence &&
                reference.ordinal === entry.ordinal &&
                reference.source === "related" &&
                reference.messageIndex === position[0] &&
                reference.path.length === 2 &&
                reference.path[0] === "parts" &&
                reference.path[1] === position[1],
            ),
          );
          if (!result) throw new Error("Saved result position is unavailable");
          targets.set(result.key, entry.key);
          return result;
        });
      }
      if (observation.has_result === false) {
        for (const result of associatedResults) {
          if (
            result.value.part_kind === "tool-return" &&
            result.value.tool_call_id === action.value.tool_call_id &&
            result.value.tool_name === action.value.tool_name &&
            result.value.outcome === "interrupted"
          )
            toolHidden.add(result.key);
        }
        action.results = [];
      }
      action.lifecycle = {
        status: observation.status as LiveTool["status"],
        started_at: observation.started_at,
        completed_at: observation.completed_at,
        saved: true,
        has_result:
          typeof observation.has_result === "boolean"
            ? observation.has_result
            : action.results.length > 0,
        content_version:
          typeof observation.content_version === "string"
            ? observation.content_version
            : null,
      };
    } else {
      const result = action.results.find((result) =>
        ["tool-return", "retry-prompt"].includes(
          String(result.value.part_kind),
        ),
      );
      const outcome = result?.value.outcome;
      const status: LiveTool["status"] | undefined =
        result?.value.part_kind === "retry-prompt" ||
        outcome === "failed" ||
        outcome === "denied"
          ? "failed"
          : outcome === "interrupted"
            ? "cancelled"
            : outcome === "success"
              ? "completed"
              : undefined;
      if (status !== undefined)
        action.lifecycle = {
          status,
          started_at: null,
          completed_at: null,
          saved: action.results.every((result) => result.saved !== false),
          has_result: true,
        };
    }
  }
  for (const entry of entries) {
    const action = entry.action;
    if (
      action?.value.tool_name !== "discussion" ||
      !activityRecord(action.args) ||
      action.args.action !== "send" ||
      typeof action.args.body !== "string" ||
      entry.diagnostic
    )
      continue;
    for (const result of action.results) {
      if (result.value.part_kind !== "tool-return") continue;
      const source = result as ContextEntry;
      const receipt = structured(
        source,
        source.resolved.content ?? result.value.content,
      );
      if (
        activityRecord(receipt) &&
        receipt.error === undefined &&
        typeof receipt.discussion_id === "number" &&
        Number.isSafeInteger(receipt.discussion_id) &&
        receipt.discussion_id > 0 &&
        typeof receipt.id === "number" &&
        Number.isSafeInteger(receipt.id) &&
        receipt.id > 0 &&
        typeof receipt.created_at === "string"
      ) {
        action.sent = {
          discussion_id: receipt.discussion_id,
          message_id: receipt.id,
          created_at: receipt.created_at,
        };
        entry.reply = action.args.body;
        entry.replyPosition ??= result.key;
      }
    }
  }
  const hidden = new Set<string>(toolHidden);
  for (const entry of entries) {
    for (const result of entry.action?.results ?? []) hidden.add(result.key);
    if (entry.workRecord) {
      const text = entry.resolved.content;
      const reply = entries.find(
        (candidate) =>
          candidate.sequence === entry.sequence &&
          candidate.ordinal <= entry.ordinal &&
          candidate.reply !== undefined &&
          typeof text === "string" &&
          candidate.reply === text,
      );
      if (reply) {
        reply.references.push(...entry.references);
        targets.set(entry.key, reply.key);
        workReferences.add(entry.key);
        hidden.add(entry.key);
      }
    }
  }
  for (const item of coverage) {
    const target = renamed.get(item.target) ?? item.target;
    if (toolHidden.has(target)) {
      item.kind = "inspection";
      item.target = "Full context";
    } else {
      if (workReferences.has(target)) item.kind = "reference";
      item.target = targets.get(target) ?? target;
    }
  }
  const positions = new Map(entries.map((entry, index) => [entry.key, index]));
  return {
    entries: entries
      .filter((entry) => !hidden.has(entry.key))
      .sort(
        (left, right) =>
          (positions.get(left.replyPosition ?? left.key) ?? 0) -
          (positions.get(right.replyPosition ?? right.key) ?? 0),
      ),
    coverage,
    missing: [...new Set(missing)],
  };
}
