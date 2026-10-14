import { clsx } from "clsx";
import {
  ChevronDown,
  FileText,
  ImageIcon,
  Search,
  Terminal,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useOrganization } from "@/app/organization";
import { Modal } from "@/components/ui/dialog";
import {
  Avatar,
  Button,
  LoadingSkeleton,
  Skeleton,
  Spinner,
} from "@/components/ui/index";
import { StatePanel } from "@/components/ui/state-panel";
import { Tooltip } from "@/components/ui/tooltip";
import { MessageAttachment } from "@/features/discussions/attachments";
import {
  type ActivityAction,
  type ActivityData,
  activityParts,
  activityRecord,
  activityText,
  clearLiveActivity,
  loadActivity,
  mergeActivityData,
  readableResult,
} from "@/features/members/activity-data";
import { useLiveTool } from "@/features/members/live-tool";
import { useWindowState } from "@/features/members/window-cache";
import {
  type AgentHistoryRun,
  BackendError,
  backend,
  type HistoryBinary,
  type HistoryReminder,
  type HistoryText,
  type HistoryValue,
  type Message,
} from "@/lib/backend";
import { formatTime, relativeTime } from "@/lib/format";

type ReadState = {
  data: ActivityData | null;
  loading: boolean;
  error: BackendError | null;
};
type SavedMessage = { message: Message; topic: string | null };
type ConversationUnit = {
  key: string;
  sequence: number;
  timestamp: string;
  side: "trigger" | "agent";
  senderId?: number;
  source?: HistoryReminder;
  action?: ActivityAction;
  text?: HistoryValue;
  saved?: boolean;
  state?: ReadState;
  notice?: string;
  workRecord?: boolean;
  order?: number[];
};

function problem(value: unknown): BackendError {
  return value instanceof BackendError
    ? value
    : new BackendError(
        "history_invalid",
        value instanceof Error ? value.message : String(value),
      );
}

function messageKey(identity: HistoryReminder) {
  return `${identity.discussion_id}:${identity.message_id}`;
}

function ActivityReader({
  agentId,
  run,
  onChange,
  register,
}: {
  agentId: number;
  run: AgentHistoryRun;
  onChange: (sequence: number, update: (saved: ReadState) => ReadState) => void;
  register: (sequence: number, retry: (() => void) | null) => void;
}) {
  const request = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const connected = useRef(true);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmed = useRef<{ epoch: string | null; revision: number }>({
    epoch: null,
    revision: 0,
  });
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const load = useCallback((): Promise<void> => {
    if (!connected.current) return Promise.resolve();
    clearTimer();
    if (pending.current) {
      dirty.current = true;
      return pending.current;
    }
    const current = generation.current;
    const abort = new AbortController();
    request.current = abort;
    dirty.current = false;
    onChange(run.sequence, (saved) => ({ ...saved, loading: true }));
    const operation = Promise.resolve().then(async () => {
      if (abort.signal.aborted || current !== generation.current) return;
      try {
        for (;;) {
          try {
            await loadActivity(agentId, run.sequence, abort.signal, (data) => {
              if (abort.signal.aborted || current !== generation.current)
                return;
              const version = data.usageVersion;
              const revision = version?.live_versions?.find(
                ([id, sequence]) => id === agentId && sequence === run.sequence,
              )?.[2];
              if (
                version?.runtime_epoch === confirmed.current.epoch &&
                revision !== undefined &&
                revision < confirmed.current.revision
              ) {
                dirty.current = true;
                return;
              }
              onChange(run.sequence, (saved) => ({
                ...saved,
                data: mergeActivityData(saved.data, data),
                error: null,
              }));
            });
            if (abort.signal.aborted || current !== generation.current) return;
            onChange(run.sequence, (saved) => ({ ...saved, error: null }));
          } catch (error) {
            if (abort.signal.aborted || current !== generation.current) return;
            onChange(run.sequence, (saved) => ({
              ...saved,
              error: problem(error),
            }));
          }
          if (
            !dirty.current ||
            abort.signal.aborted ||
            current !== generation.current
          )
            return;
          dirty.current = false;
        }
      } finally {
        if (
          !abort.signal.aborted &&
          current === generation.current &&
          pending.current === operation
        ) {
          pending.current = null;
          onChange(run.sequence, (saved) => ({ ...saved, loading: false }));
        }
      }
    });
    pending.current = operation;
    return operation;
  }, [agentId, clearTimer, run.sequence, onChange]);
  useEffect(() => {
    connected.current = true;
    const schedule = (immediate = false) => {
      if (!connected.current) return;
      if (pending.current || immediate) void load();
      else if (timer.current === null)
        timer.current = setTimeout(() => {
          timer.current = null;
          void load();
        }, 150);
    };
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        connected.current = false;
        generation.current += 1;
        request.current?.abort();
        pending.current = null;
        dirty.current = false;
        clearTimer();
        confirmed.current = { epoch: null, revision: 0 };
        onChange(run.sequence, (saved) => ({
          ...saved,
          loading: false,
          data: saved.data ? clearLiveActivity(saved.data) : null,
        }));
        return;
      }
      if (event.type === "connection.restored") {
        connected.current = true;
        generation.current += 1;
        void load();
        return;
      }
      if (
        (event.type.startsWith("turn.") ||
          event.type === "tool.updated" ||
          event.type === "usage.updated") &&
        event.agent_id === agentId &&
        event.sequence === run.sequence
      ) {
        if (
          event.saved === true &&
          typeof event.runtime_epoch === "string" &&
          typeof event.live_revision === "number"
        ) {
          confirmed.current = {
            epoch: event.runtime_epoch,
            revision: Math.max(
              confirmed.current.epoch === event.runtime_epoch
                ? confirmed.current.revision
                : 0,
              event.live_revision,
            ),
          };
        }
        schedule(event.type === "turn.finished");
      }
    });
    return () => {
      connected.current = false;
      generation.current += 1;
      request.current?.abort();
      pending.current = null;
      dirty.current = false;
      clearTimer();
      off();
    };
  }, [agentId, clearTimer, run.sequence, load, onChange]);
  useEffect(() => {
    void load();
  }, [run.status, run.last_saved_at, run.request_count, load]);
  useEffect(() => {
    register(run.sequence, () => void load());
    return () => register(run.sequence, null);
  }, [run.sequence, load, register]);
  return null;
}

export function ConversationFeed({
  agentId,
  runs,
  loading,
}: {
  agentId: number;
  runs: AgentHistoryRun[];
  loading: boolean;
}) {
  const { members } = useOrganization();
  const name =
    members?.find((member) => member.id === agentId)?.name ??
    `Agent ${agentId}`;
  const [reads, setReads] = useWindowState<Record<number, ReadState>>(
    "conversation:reads",
    {},
  );
  const [messages, setMessages] = useWindowState<Record<string, SavedMessage>>(
    "conversation:messages",
    {},
  );
  const onChange = useCallback(
    (sequence: number, update: (saved: ReadState) => ReadState) => {
      setReads((saved) => ({
        ...saved,
        [sequence]: update(
          saved[sequence] ?? { data: null, loading: false, error: null },
        ),
      }));
    },
    [setReads],
  );
  const onMessage = useCallback(
    (identity: string, message: SavedMessage) => {
      setMessages((saved) => ({ ...saved, [identity]: message }));
    },
    [setMessages],
  );
  const retries = useRef(new Map<number, () => void>());
  const register = useCallback(
    (sequence: number, retry: (() => void) | null) => {
      if (retry) retries.current.set(sequence, retry);
      else retries.current.delete(sequence);
    },
    [],
  );
  const onRetry = useCallback((sequence: number) => {
    const retry = retries.current.get(sequence);
    if (!retry) throw new Error("Activity retry is unavailable");
    retry();
  }, []);
  const disconnected = backend.disconnected;
  const units: ConversationUnit[] = [];
  for (const run of runs) {
    const state = reads[run.sequence];
    const data = state?.data;
    const base = { sequence: run.sequence, timestamp: run.started_at };
    const identities = data?.run.reminded ?? run.reminded;
    if (identities === undefined) {
      units.push({
        ...base,
        key: `${run.sequence}:trigger`,
        side: "trigger",
        notice: "Loading trigger information",
      });
    } else if (!identities.length) {
      units.push({
        ...base,
        key: `${run.sequence}:trigger`,
        side: "trigger",
        notice: "No saved trigger information",
      });
    } else {
      const seen = new Set<string>();
      for (const source of identities) {
        const id = messageKey(source);
        if (seen.has(id)) continue;
        seen.add(id);
        const saved = messages[id];
        units.push({
          ...base,
          key: `${run.sequence}:trigger:${id}`,
          side: "trigger",
          source,
          timestamp: saved?.message.created_at ?? run.started_at,
          senderId: saved?.message.sender_id,
        });
      }
    }
    const agentUnits: ConversationUnit[] = [];
    const replies = new Set<string>();
    for (const action of data?.actions ?? []) {
      const sent = action.sent;
      const id = sent ? messageKey(sent) : action.key;
      if (sent && replies.has(id)) continue;
      if (sent) replies.add(id);
      agentUnits.push({
        ...base,
        key: `${run.sequence}:${sent ? "reply" : "action"}:${id}`,
        side: "agent",
        senderId: agentId,
        timestamp:
          (sent ? messages[id]?.message.created_at : undefined) ??
          sent?.created_at ??
          action.timestamp ??
          data?.contents[action.ordinal]?.summary.started_at ??
          run.started_at,
        source: sent ?? undefined,
        action: sent ? undefined : action,
        order: [action.ordinal, action.messageIndex, action.partIndex],
      });
    }
    for (const part of data?.notes ?? []) {
      if (part.value.part_kind !== "text") continue;
      agentUnits.push({
        ...base,
        key: `${run.sequence}:text:${part.key}`,
        side: "agent",
        senderId: agentId,
        timestamp: part.timestamp ?? run.started_at,
        text: part.value.content,
        saved: part.saved,
        order: [part.ordinal, part.messageIndex, part.partIndex],
      });
    }
    agentUnits.sort(
      (left, right) =>
        Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
        (left.order?.[0] ?? 0) - (right.order?.[0] ?? 0) ||
        (left.order?.[1] ?? 0) - (right.order?.[1] ?? 0) ||
        (left.order?.[2] ?? 0) - (right.order?.[2] ?? 0),
    );
    units.push(...agentUnits);
    for (const part of data?.final ?? [])
      units.push({
        ...base,
        key: `${run.sequence}:record:${part.key}`,
        side: "agent",
        senderId: agentId,
        timestamp: part.timestamp ?? run.completed_at ?? run.started_at,
        text: part.value.content,
        workRecord: true,
      });
    const notice =
      data?.run.error ??
      (data?.missing.length
        ? `Historical content is incomplete: ${data.missing.join(", ")}`
        : data?.complete && !agentUnits.length && !data.final.length
          ? data.run.status === "running"
            ? "Waiting for saved content"
            : "No saved content"
          : undefined);
    if (
      notice ||
      state?.error ||
      state?.loading ||
      !state ||
      data?.run.status === "running"
    ) {
      units.push({
        ...base,
        key: `${run.sequence}:state`,
        side: "agent",
        senderId: agentId,
        state,
        notice,
      });
    }
  }
  return (
    <div
      role="feed"
      aria-label="Activity history"
      className="flex w-full min-w-0 flex-col"
    >
      {runs.map((run) => (
        <ActivityReader
          key={run.sequence}
          agentId={agentId}
          run={run}
          onChange={onChange}
          register={register}
        />
      ))}
      {!runs.length && !loading ? (
        <StatePanel
          compact
          icons={[Terminal, FileText, Search]}
          title="No activity yet"
          description="This Agent's activity will appear here."
        />
      ) : null}
      {units.map((unit, index) => {
        const previous = units[index - 1];
        const grouped =
          previous?.side === unit.side &&
          unit.senderId !== undefined &&
          previous.senderId === unit.senderId &&
          Math.abs(
            Date.parse(unit.timestamp) - Date.parse(previous.timestamp),
          ) < 300_000;
        return (
          <ConversationEntry
            key={unit.key}
            identity={unit.key}
            sequence={unit.sequence}
            timestamp={unit.timestamp}
            side={unit.side}
            senderId={unit.senderId}
            source={unit.source}
            action={unit.action}
            text={unit.text}
            state={unit.state}
            notice={unit.notice}
            workRecord={unit.workRecord}
            grouped={grouped}
            saved={unit.saved}
            agentId={agentId}
            name={unit.side === "agent" ? name : undefined}
            complete={reads[unit.sequence]?.data?.complete ?? false}
            running={reads[unit.sequence]?.data?.run.status === "running"}
            disconnected={disconnected}
            onMessage={onMessage}
            onRetry={onRetry}
          />
        );
      })}
    </div>
  );
}

const ConversationEntry = memo(function ConversationEntry({
  identity,
  sequence,
  timestamp,
  side,
  senderId,
  source,
  action,
  text,
  saved,
  state,
  notice,
  workRecord,
  grouped,
  agentId,
  name,
  complete,
  running,
  disconnected,
  onMessage,
  onRetry,
}: Omit<ConversationUnit, "key" | "order"> & {
  identity: string;
  grouped: boolean;
  agentId: number;
  name?: string;
  complete: boolean;
  running: boolean;
  disconnected: boolean;
  onMessage: (identity: string, saved: SavedMessage) => void;
  onRetry: (sequence: number) => void;
}) {
  return source ? (
    <MessageBubble
      unit={{ key: identity, sequence, timestamp, side, senderId, source }}
      agentId={agentId}
      grouped={grouped}
      disconnected={disconnected}
      onMessage={onMessage}
    />
  ) : (
    <Bubble
      identity={identity}
      side={side}
      senderId={senderId}
      name={name}
      timestamp={timestamp}
      grouped={grouped}
      label={workRecord ? "Agent work record" : undefined}
    >
      {action ? (
        <ToolAction
          agentId={agentId}
          sequence={sequence}
          action={action}
          complete={complete}
          running={running}
        />
      ) : null}
      {saved === false ? (
        <p className="m-0 text-xs text-danger">Not saved</p>
      ) : null}
      {text !== undefined ? (
        <Content
          agentId={agentId}
          sequence={sequence}
          identity={identity}
          value={text}
          markdown
        />
      ) : null}
      {notice === "Loading trigger information" && !disconnected ? (
        <LoadingSkeleton label={notice}>
          <Skeleton className="w-48 max-w-full" />
          <Skeleton className="w-32 max-w-full" />
        </LoadingSkeleton>
      ) : notice ? (
        <p className="m-0 wrap-anywhere">{notice}</p>
      ) : null}
      {state?.error ? (
        <Retry
          error={state.error.message}
          loading={state.loading}
          label="Retry activity"
          onRetry={() => onRetry(sequence)}
        />
      ) : null}
      {identity.endsWith(":state") &&
      !state?.data &&
      !state?.error &&
      !disconnected ? (
        <LoadingSkeleton label="Reading saved activity">
          <Skeleton className="w-48 max-w-full" />
          <Skeleton className="w-32 max-w-full" />
        </LoadingSkeleton>
      ) : state?.data && (state.loading || running) ? (
        <Spinner label="Reading saved activity" />
      ) : null}
    </Bubble>
  );
});

function Bubble({
  identity,
  side,
  senderId,
  name,
  timestamp,
  grouped,
  label,
  target,
  children,
}: {
  identity: string;
  side: "trigger" | "agent";
  senderId?: number;
  name?: string;
  timestamp: string;
  grouped: boolean;
  label?: string;
  target?: string;
  children: ReactNode;
}) {
  const avatar =
    senderId === undefined ? null : <Avatar memberId={senderId} size="md" />;
  return (
    <article
      aria-label={
        label ?? (side === "trigger" ? "Trigger message" : "Agent message")
      }
      data-activity-anchor={identity}
      className={clsx(
        "flex w-full min-w-0 items-end gap-2",
        side === "trigger" && "justify-end",
        grouped ? "mt-1" : "mt-4",
      )}
    >
      {side === "agent" ? avatar : null}
      <div className="flex min-w-0 max-w-[85%] flex-col">
        <div
          className={clsx(
            "mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted",
            side === "trigger" && "justify-end",
          )}
        >
          {name ? <span className="font-semibold">{name}</span> : null}
          <Tooltip label={formatTime(timestamp)}>
            <time dateTime={timestamp}>{relativeTime(timestamp)}</time>
          </Tooltip>
          {target ? <span className="wrap-anywhere">{target}</span> : null}
          {label ? <span>{label}</span> : null}
        </div>
        <div
          className={clsx(
            "w-fit min-w-0 rounded-lg px-4 py-3 text-sm leading-body wrap-anywhere",
            side === "trigger"
              ? "ml-auto bg-surface-hover"
              : "border border-line bg-surface-raised",
          )}
        >
          {children}
        </div>
      </div>
      {side === "trigger" ? avatar : null}
    </article>
  );
}

function Retry({
  error,
  label,
  loading,
  onRetry,
}: {
  error: string;
  label: string;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-w-0 flex-col items-start gap-2 text-sm text-danger"
    >
      <span className="wrap-anywhere">{error}</span>
      <Button size="sm" disabled={loading} onClick={onRetry}>
        {label}
      </Button>
    </div>
  );
}

function MessageBubble({
  unit,
  agentId,
  grouped,
  disconnected,
  onMessage,
}: {
  unit: ConversationUnit;
  agentId: number;
  grouped: boolean;
  disconnected: boolean;
  onMessage: (identity: string, saved: SavedMessage) => void;
}) {
  const identity = unit.source;
  if (!identity) throw new Error("Saved message identity is missing");
  const id = messageKey(identity);
  const [saved, setSaved] = useWindowState<SavedMessage | null>(
    `message:${id}`,
    null,
  );
  const [error, setError] = useState<BackendError | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const isReply = unit.side === "agent";
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const page = await backend.discussionPage(identity.discussion_id, {
        after: identity.message_id - 1,
        before: identity.message_id + 1,
        limit: 1,
        metadata: true,
      });
      if (current !== generation.current) return;
      if (page.id !== identity.discussion_id)
        throw new Error("Saved message discussion does not match");
      const message = page.messages.find(
        (message) => message.id === identity.message_id,
      );
      if (!message) throw new BackendError("not_found", "Message not found");
      if (isReply && message.sender_id !== agentId)
        throw new Error("Saved reply sender does not match this Agent");
      const next = { message, topic: page.metadata?.topic ?? null };
      setSaved(next);
      onMessage(id, next);
      setError(null);
    } catch (error) {
      if (current === generation.current) setError(problem(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [
    identity.discussion_id,
    identity.message_id,
    id,
    agentId,
    isReply,
    setSaved,
    onMessage,
  ]);
  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        generation.current += 1;
        setLoading(false);
      }
      if (event.type === "connection.restored") void load();
    });
    return () => {
      generation.current += 1;
      off();
    };
  }, [load]);
  const label = isReply ? "Agent reply" : "Trigger message";
  const errorLabel =
    error?.code === "not_found"
      ? `${label} not found`
      : ["not_a_member", "not_permitted", "permission_denied"].includes(
            error?.code ?? "",
          )
        ? `Access denied to ${label.toLowerCase()}`
        : error?.message;
  return (
    <Bubble
      identity={unit.key}
      side={unit.side}
      senderId={saved?.message.sender_id}
      name={saved?.message.sender_name}
      timestamp={saved?.message.created_at ?? unit.timestamp}
      grouped={grouped}
      target={
        isReply
          ? `Sent to ${saved?.topic ?? `Discussion ${identity.discussion_id}`}`
          : undefined
      }
    >
      {saved ? (
        <>
          <LongContent identity={unit.key}>
            <Prose>{saved.message.body}</Prose>
          </LongContent>
          {saved.message.attachments.map((attachment) => (
            <MessageAttachment
              key={attachment.id}
              discussionId={identity.discussion_id}
              messageId={identity.message_id}
              attachment={attachment}
              thumbnail
            />
          ))}
        </>
      ) : null}
      {!saved && !error && !disconnected ? (
        <LoadingSkeleton label={`Loading ${label.toLowerCase()}`}>
          <Skeleton className="w-48 max-w-full" />
          <Skeleton className="w-32 max-w-full" />
        </LoadingSkeleton>
      ) : saved && loading ? (
        <Spinner label={`Loading ${label.toLowerCase()}`} />
      ) : null}
      {errorLabel ? (
        <Retry
          error={errorLabel}
          label="Retry message"
          loading={loading}
          onRetry={() => void load()}
        />
      ) : null}
    </Bubble>
  );
}

function displayPath(value: string): string {
  const absolute = value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);
  const parts = value.split(/[\\/]/).filter(Boolean);
  const source = parts.findIndex((part) =>
    [
      "library",
      "workspace",
      "webui",
      "core",
      "scripts",
      "docs",
      "tests",
    ].includes(part),
  );
  if (source >= 0 && !parts.slice(source).includes(".venv"))
    return parts.slice(source).join("/");
  if (
    absolute ||
    parts.some((part) =>
      [".venv", "venv", ".task-data", ".cache", "tmp"].includes(part),
    )
  )
    return parts[parts.length - 1] ?? value;
  return value;
}

function toolDisplay(
  tool: string,
  value: HistoryValue,
  parameters = false,
): HistoryValue {
  if (
    ![
      "run",
      "edit",
      "discussion",
      "organization",
      "history",
      "web_search",
      "view_image",
      "view_attachment",
    ].includes(tool) ||
    activityText(value)
  )
    return value;
  if (Array.isArray(value)) {
    const images = value.filter(
      (item) => activityRecord(item) && item.kind === "binary",
    );
    if (tool.startsWith("view_") && images.length) return images;
    return value.map((item) => toolDisplay(tool, item));
  }
  if (!activityRecord(value)) return value;
  if (value.kind === "binary") return value;
  if (tool === "run") {
    if (parameters) {
      const argv = Array.isArray(value.argv) ? value.argv.map(String) : [];
      const executable = (argv[0] ?? "command").split(/[\\/]/);
      const program = executable[executable.length - 1];
      const argumentsToDisplay = argv.map((argument, index) =>
        index === 0 ||
        (["cat", "head", "tail"].includes(program) &&
          index === argv.length - 1 &&
          !argument.startsWith("-"))
          ? displayPath(argument)
          : argument,
      );
      if (
        argumentsToDisplay.some(
          (argument) =>
            !URL.canParse(argument) &&
            /(^|[\s"'=(])\/(?:project|tmp|root|mnt|var\/tmp)(?:\/|$)|(^|[\\/])(?:\.venv|venv|\.task-data|\.cache)[\\/]/.test(
              argument,
            ),
        )
      )
        return {
          "Command summary": `Run ${program}`,
          Details:
            "Open Inspect context for the complete command and arguments.",
        };
      const command = argumentsToDisplay
        .map((argument) =>
          /^[\p{L}\p{N}_./:=+-]+$/u.test(argument)
            ? argument
            : JSON.stringify(argument),
        )
        .join(" ");
      return { Command: command };
    }
    return {
      ...(value.stdout ? { Output: value.stdout } : {}),
      ...(value.stderr ? { "Error output": value.stderr } : {}),
      ...(value.error ? { Error: value.error } : {}),
      ...(typeof value.exit_code === "number"
        ? { Status: `Exited with code ${value.exit_code}` }
        : {}),
      ...(value.truncated ? { Notice: "Output was truncated" } : {}),
    };
  }
  if (tool === "edit") {
    if (parameters)
      return {
        File: displayPath(String(value.path ?? "")),
        Changes: Array.isArray(value.edits)
          ? value.edits.map((edit) => {
              if (!activityRecord(edit)) return edit;
              return {
                "Original text": edit.old_text ?? "",
                "Updated text": edit.new_text ?? "",
              };
            })
          : [],
      };
    return {
      File: displayPath(String(value.path ?? "")),
      ...(value.error ? { Error: value.error } : {}),
      ...(typeof value.created === "boolean" && !value.error
        ? { Status: value.created ? "File created" : "File updated" }
        : {}),
      ...(typeof value.replacements === "number"
        ? { Changes: `${value.replacements} replacements` }
        : {}),
    };
  }
  if (tool === "discussion" && Array.isArray(value.messages))
    return {
      Messages: value.messages.map((message) => {
        if (!activityRecord(message)) return message;
        return {
          Sender: message.sender_name ?? message.sender_id ?? "",
          Message: message.body ?? "",
          ...(Array.isArray(message.attachments) && message.attachments.length
            ? {
                Attachments: message.attachments.map((attachment) =>
                  activityRecord(attachment)
                    ? (attachment.name ?? "Saved attachment")
                    : attachment,
                ),
              }
            : {}),
        };
      }),
    };
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cwd")
      .map(([key, item]) => [
        key,
        typeof item === "string" && ["path", "directory", "file"].includes(key)
          ? displayPath(item)
          : toolDisplay(tool, item),
      ]),
  );
}

export function actionSummary(
  action: ActivityAction,
  topics: Map<number, string> = new Map(),
  names: Map<number, string> = new Map(),
): string {
  const tool = String(action.value.tool_name);
  const args = activityRecord(action.args) ? action.args : {};
  const value = (key: string) =>
    typeof args[key] === "string" || typeof args[key] === "number"
      ? String(args[key])
      : "";
  if (tool === "run") {
    const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
    const path = (argv[0] ?? "command").split(/[\\/]/);
    const program = path[path.length - 1];
    if (["cat", "head", "tail"].includes(program))
      return `Read file ${displayPath(argv[argv.length - 1] ?? "")}`;
    if (
      ["pytest", "vitest"].includes(program) ||
      argv.some((arg) =>
        ["pytest", "test", "test:webui", "test:core"].includes(arg),
      )
    )
      return "Run tests";
    if (program === "rg") return "Search files";
    if (program === "git") return `Run git ${argv[1] ?? ""}`.trim();
    return `Run ${program}`;
  }
  if (tool === "edit")
    return `${args.create ? "Create file" : "Edit file"} ${displayPath(value("path"))}`.trim();
  if (tool === "web_search") return `Search ${value("query")}`.trim();
  if (tool === "view_image")
    return `View image ${displayPath(value("path"))}`.trim();
  if (tool === "view_attachment") return "View attachment";
  if (tool === "discussion") {
    const verbs: Record<string, string> = {
      read: "Read",
      search: "Search",
      send: "Send to",
      ack: "Mark handled in",
      list: "List",
      create: "Create",
      add_members: "Add Members to",
      remove_members: "Remove Members from",
      archive: "Archive",
      unarchive: "Unarchive",
    };
    const target =
      topics.get(Number(args.discussion_id)) ??
      (args.discussion_id
        ? `Discussion ${value("discussion_id")}`
        : value("topic") || "Discussions");
    return `${verbs[value("action")] ?? value("action")} ${target}`.trim();
  }
  if (tool === "organization") {
    const verbs: Record<string, string> = {
      list_members: "Read Members",
      create_agent: "Create Agent",
      get_model: "Read model for",
      rename_member: "Rename",
      pause_agent: "Pause",
      resume_agent: "Resume",
      delete_member: "Delete",
    };
    return `${verbs[value("action")] ?? value("action")} ${value("name") || names.get(Number(args.member_id)) || (args.member_id ? `Member ${value("member_id")}` : "")}`.trim();
  }
  if (tool === "history")
    return `${value("action") === "search" ? "Search" : "Read"} history ${value("query") || value("sequence")}`.trim();
  return tool;
}

function ToolAction({
  agentId,
  sequence,
  action,
  complete,
  running,
}: {
  agentId: number;
  sequence: number;
  action: ActivityAction;
  complete: boolean;
  running: boolean;
}) {
  const { members, discussions } = useOrganization();
  const title = actionSummary(
    action,
    new Map(
      discussions?.map((discussion) => [discussion.id, discussion.topic]),
    ),
    new Map(members?.map((member) => [member.id, member.name])),
  );
  const [opened, setOpened] = useWindowState(
    `action:${sequence}:${action.key}`,
    false,
  );
  const tool = String(action.value.tool_name);
  const observing =
    action.ordinal > 0 && (running || action.observation !== undefined);
  const live = useLiveTool({
    agentId,
    sequence,
    ordinal: action.ordinal,
    partIndex: action.partIndex,
    toolCallId: String(action.value.tool_call_id),
    requestId: action.requestId,
    enabled: observing,
    opened,
  });
  const observed = observing ? live.observed : null;
  const lifecycle = observed?.tool ?? action.lifecycle;
  const results =
    observed?.content && (!observed.tool.saved || !action.results.length)
      ? activityParts(observed.content, action.ordinal, "live")
      : action.results;
  const failed =
    lifecycle?.status === "failed" ||
    (!lifecycle &&
      results.some(
        (result) =>
          result.value.part_kind === "retry-prompt" ||
          ["failed", "denied"].includes(String(result.value.outcome)),
      ));
  const Icon =
    tool === "run"
      ? Terminal
      : tool.startsWith("view_")
        ? ImageIcon
        : tool === "web_search"
          ? Search
          : FileText;
  const status = lifecycle
    ? {
        queued: "Queued",
        running: "Running",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Cancelled",
      }[lifecycle.status]
    : failed
      ? "Failed"
      : results.length
        ? "Result saved"
        : !complete
          ? "Loading result"
          : running
            ? "Waiting for result"
            : "No saved result";
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={opened}
        aria-label={`${title} · ${status}`}
        onClick={() => setOpened((value) => !value)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-surface-hover"
      >
        <Tooltip label={status}>
          <Icon
            className={clsx(
              "size-4 flex-none",
              failed ? "text-danger" : "text-fg-muted",
            )}
            aria-hidden="true"
          />
        </Tooltip>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ChevronDown
          className="size-4 flex-none text-fg-muted"
          aria-hidden="true"
        />
      </button>
      {opened ? (
        <div className="mt-2 flex min-w-0 flex-col gap-3 overflow-x-auto rounded-sm bg-app p-3 font-mono text-xs whitespace-pre-wrap">
          <Content
            agentId={agentId}
            sequence={sequence}
            identity={`${action.key}:parameters`}
            value={toolDisplay(tool, action.args, true)}
          />
          {(lifecycle?.has_result && lifecycle.saved === false) ||
          action.saved === false ? (
            <p className="m-0 text-xs text-danger">Not saved</p>
          ) : null}
          {lifecycle?.started_at ? (
            <p className="m-0 text-fg-muted">
              Started {formatTime(lifecycle.started_at)}
            </p>
          ) : null}
          {lifecycle?.completed_at ? (
            <p className="m-0 text-fg-muted">
              Finished {formatTime(lifecycle.completed_at)}
            </p>
          ) : null}
          {live.error && !(live.error.transport && backend.disconnected) ? (
            <Retry
              error={live.error.message}
              loading={live.loading}
              label="Retry result"
              onRetry={live.retry}
            />
          ) : null}
          {results.map((result) => (
            <ToolResult
              key={result.key}
              agentId={agentId}
              sequence={sequence}
              identity={result.key}
              tool={tool}
              value={result.value.content}
              structured={
                result.value.part_kind === "tool-return" &&
                [
                  "run",
                  "edit",
                  "discussion",
                  "organization",
                  "history",
                  "web_search",
                  "view_image",
                  "view_attachment",
                ].includes(tool)
              }
            />
          ))}
          {!results.length ? (
            <p className="m-0 text-fg-muted">{status}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type ResultState = {
  signature: string;
  reading: HistoryValue;
  parsed?: HistoryValue;
};
function ToolResult({
  agentId,
  sequence,
  identity,
  tool,
  value,
  structured,
}: {
  agentId: number;
  sequence: number;
  identity: string;
  tool: string;
  value: HistoryValue;
  structured: boolean;
}) {
  const signature = JSON.stringify(value);
  const [saved, setSaved] = useWindowState<ResultState>(
    `result:${sequence}:${identity}`,
    { signature, reading: value },
  );
  const current = useRef(saved);
  const [error, setError] = useState<BackendError | null>(null);
  const [loading, setLoading] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const read =
    structured && (typeof value === "string" || activityText(value) !== null);
  const ready = saved.signature === signature && saved.parsed !== undefined;
  const load = useCallback(async () => {
    if (!read || ready) return;
    operation.current?.abort();
    const abort = new AbortController();
    operation.current = abort;
    setLoading(true);
    try {
      const parsed = await readableResult(
        agentId,
        sequence,
        current.current.signature === signature
          ? current.current.reading
          : value,
        abort.signal,
        (reading) => {
          if (abort.signal.aborted) return;
          current.current = { signature, reading };
          setSaved(current.current);
        },
      );
      if (abort.signal.aborted) return;
      current.current = { signature, reading: current.current.reading, parsed };
      setSaved(current.current);
      setError(null);
    } catch (error) {
      if (!abort.signal.aborted) setError(problem(error));
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, [agentId, sequence, signature, value, read, ready, setSaved, identity]);
  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        operation.current?.abort();
        setLoading(false);
      }
      if (event.type === "connection.restored") void load();
    });
    return () => {
      operation.current?.abort();
      off();
    };
  }, [load]);
  return (
    <div className="min-w-0">
      {loading ? <Spinner label="Loading result" /> : null}
      {error ? (
        <Retry
          error={error.message}
          loading={loading}
          label="Retry result"
          onRetry={() => void load()}
        />
      ) : null}
      {!read || ready ? (
        <Content
          agentId={agentId}
          sequence={sequence}
          identity={`${identity}:result`}
          value={toolDisplay(tool, read ? (saved.parsed ?? null) : value)}
          preview
        />
      ) : null}
    </div>
  );
}

function Prose({ children }: { children: string }) {
  return (
    <div className="prose min-w-0 max-w-full text-sm wrap-anywhere">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}

function LongContent({
  identity,
  children,
  preview = false,
}: {
  identity: string;
  children: ReactNode;
  preview?: boolean;
}) {
  const [expanded, setExpanded] = useWindowState(`body:${identity}`, false);
  const [long, setLong] = useState(preview);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const node = root.current;
    const measure = () => setLong(node.scrollHeight > (preview ? 40 : 300));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [preview]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <div
        className={clsx(
          "relative w-full min-w-0",
          !expanded &&
            long &&
            (preview
              ? "max-h-10 overflow-hidden"
              : "max-h-[300px] overflow-hidden"),
        )}
      >
        <div ref={root} className="min-w-0">
          {children}
        </div>
        {!expanded && long ? (
          <div
            aria-hidden="true"
            className={clsx(
              "pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t to-transparent",
              preview ? "h-5 from-app" : "h-12 from-surface-raised",
            )}
          />
        ) : null}
      </div>
      {long ? (
        <Button size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

function contentLeaves(
  value: HistoryValue,
  label = "",
): { label: string; value: HistoryValue }[] {
  if (activityText(value) || (activityRecord(value) && value.kind === "binary"))
    return [{ label, value }];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      contentLeaves(item, `${label} ${index + 1}`.trim()),
    );
  if (activityRecord(value))
    return Object.entries(value).flatMap(([key, item]) =>
      contentLeaves(item, [label, key].filter(Boolean).join(" · ")),
    );
  return [{ label, value }];
}

const Content = memo(function Content({
  agentId,
  sequence,
  identity,
  value,
  markdown = false,
  preview = false,
}: {
  agentId: number;
  sequence: number;
  identity: string;
  value: HistoryValue;
  markdown?: boolean;
  preview?: boolean;
}) {
  const leaves = contentLeaves(value);
  const hasImage = leaves.some(
    (leaf) => activityRecord(leaf.value) && leaf.value.kind === "binary",
  );
  const previewText = preview && !hasImage;
  const content = (
    <div className="flex min-w-0 flex-col gap-2">
      {leaves.map((leaf, index) => {
        const text = activityText(leaf.value);
        const key = `${identity}:${leaf.label || index}`;
        if (text) {
          const textKey = `${text.source}:${text.request_ordinal}:${text.message_index}:${JSON.stringify(text.path)}`;
          const body = (
            <TextContent
              key={textKey}
              agentId={agentId}
              sequence={sequence}
              reference={text}
              markdown={markdown}
            />
          );
          return previewText ? (
            <LongContent
              key={textKey}
              identity={`${sequence}:${key}:${textKey}`}
              preview
            >
              {body}
            </LongContent>
          ) : (
            body
          );
        }
        if (activityRecord(leaf.value) && leaf.value.kind === "binary") {
          const reference = leaf.value as unknown as HistoryBinary;
          return (
            <ImageContent
              key={`${reference.source}:${reference.request_ordinal}:${reference.message_index}:${JSON.stringify(reference.path)}`}
              agentId={agentId}
              sequence={sequence}
              reference={reference}
            />
          );
        }
        const body =
          markdown && typeof leaf.value === "string" ? (
            <Prose>{leaf.value}</Prose>
          ) : (
            <pre className="m-0 min-w-0 max-w-full overflow-x-auto font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere">
              {leaf.value === null ? "null" : String(leaf.value)}
            </pre>
          );
        return (
          <div key={key} className="min-w-0">
            {leaf.label ? (
              <div className="text-xs text-fg-muted wrap-anywhere">
                {leaf.label}
              </div>
            ) : null}
            {previewText ? (
              <LongContent identity={`${sequence}:${key}`} preview>
                {body}
              </LongContent>
            ) : (
              body
            )}
          </div>
        );
      })}
    </div>
  );
  return previewText ? (
    content
  ) : (
    <LongContent identity={`${sequence}:${identity}`}>{content}</LongContent>
  );
});

function liveSignature(reference: HistoryText | HistoryBinary): string | null {
  return reference.source === "live"
    ? JSON.stringify([
        reference.runtime_epoch,
        reference.part_index,
        reference.content_source,
        reference.content_version,
      ])
    : null;
}

function TextContent({
  agentId,
  sequence,
  reference,
  markdown,
}: {
  agentId: number;
  sequence: number;
  reference: HistoryText;
  markdown: boolean;
}) {
  const key = `text:${sequence}:${reference.source}:${reference.request_ordinal}:${reference.message_index}:${JSON.stringify(reference.path)}`;
  const [saved, setSaved] = useWindowState(key, reference);
  const signature = liveSignature(reference);
  const [savedSignature, setSavedSignature] = useWindowState<string | null>(
    `${key}:version`,
    null,
  );
  const visible = savedSignature === signature ? saved : reference;
  const current = useRef(visible);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const interrupted = useRef<number | null>(null);
  const load = useCallback(
    async (offset = current.current.next_offset) => {
      if (busy.current) return;
      busy.current = true;
      interrupted.current = offset;
      const token = ++generation.current;
      setLoading(true);
      try {
        const page = await backend.agentHistoryText(agentId, sequence, {
          ...current.current,
          offset,
        });
        if (token !== generation.current) return;
        if (page.offset !== offset || page.next_offset <= offset)
          throw new Error("Saved text did not advance");
        const total = Math.max(current.current.total_bytes, page.total_bytes);
        current.current = {
          ...current.current,
          value: current.current.value + page.value,
          next_offset: page.next_offset,
          total_bytes: total,
          has_more: page.next_offset < total,
        };
        setSaved(current.current);
        interrupted.current = null;
        setError(null);
      } catch (error) {
        if (token === generation.current) setError(problem(error));
      } finally {
        if (token === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [agentId, sequence, setSaved],
  );
  useEffect(() => {
    const previous = current.current;
    if (
      savedSignature !== signature ||
      !previous.value.startsWith(reference.value) ||
      previous.next_offset > reference.total_bytes
    ) {
      generation.current += 1;
      busy.current = false;
      interrupted.current = null;
      current.current = reference;
      setSaved(reference);
      setSavedSignature(signature);
      setLoading(false);
      setError(null);
    } else if (reference.total_bytes !== previous.total_bytes) {
      current.current = {
        ...previous,
        total_bytes: reference.total_bytes,
        has_more: previous.next_offset < reference.total_bytes,
      };
      setSaved(current.current);
    }
  }, [reference, setSaved, signature, savedSignature, setSavedSignature]);
  useEffect(() => {
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        generation.current += 1;
        busy.current = false;
        setLoading(false);
      }
      if (event.type === "connection.restored" && interrupted.current !== null)
        void load(interrupted.current);
    });
    return () => {
      generation.current += 1;
      busy.current = false;
      off();
    };
  }, [load]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {markdown ? (
        <Prose>{visible.value}</Prose>
      ) : (
        <pre className="m-0 max-w-full overflow-x-auto text-xs leading-5 whitespace-pre-wrap wrap-anywhere">
          {visible.value}
        </pre>
      )}
      {error ? (
        <Retry
          error={error.message}
          loading={loading}
          label="Retry text"
          onRetry={() => void load()}
        />
      ) : visible.has_more ? (
        <Button size="sm" disabled={loading} onClick={() => void load()}>
          {loading ? <Spinner label="Loading text" /> : null}
          Load more text
        </Button>
      ) : null}
    </div>
  );
}

function ImageContent({
  agentId,
  sequence,
  reference,
}: {
  agentId: number;
  sequence: number;
  reference: HistoryBinary;
}) {
  const key = `image:${sequence}:${reference.source}:${reference.request_ordinal}:${reference.message_index}:${JSON.stringify(reference.path)}`;
  const [url, setUrl] = useWindowState<string | null>(key, null);
  const signature = liveSignature(reference);
  const [savedSignature, setSavedSignature] = useWindowState<string | null>(
    `${key}:version`,
    null,
  );
  const visibleUrl = savedSignature === signature ? url : null;
  const address = useRef(reference);
  address.current = reference;
  const [error, setError] = useState<BackendError | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const image = await backend.agentHistoryImage(
        agentId,
        sequence,
        address.current,
      );
      if (token !== generation.current) return;
      setUrl(`data:${image.media_type};base64,${image.data}`);
      setSavedSignature(signature);
      setError(null);
    } catch (error) {
      if (token === generation.current) setError(problem(error));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [agentId, sequence, key, signature, setUrl, setSavedSignature]);
  useEffect(() => {
    if (!visibleUrl) void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        generation.current += 1;
        setLoading(false);
      }
      if (event.type === "connection.restored") void load();
    });
    return () => {
      generation.current += 1;
      off();
    };
  }, [load, visibleUrl]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {loading ? <Spinner label="Loading image" /> : null}
      {error ? (
        <Retry
          error={error.message}
          loading={loading}
          label="Retry image"
          onRetry={() => void load()}
        />
      ) : null}
      {visibleUrl && !error ? (
        <button
          type="button"
          aria-label="Open history image"
          className="max-w-full cursor-zoom-in overflow-hidden rounded-sm"
          onClick={() => setOpen(true)}
        >
          <img
            src={visibleUrl}
            alt="Saved model content"
            className="block max-h-[200px] max-w-full object-contain"
            onError={() =>
              setError(
                new BackendError(
                  "image_failed",
                  "The saved image could not be displayed",
                ),
              )
            }
          />
        </button>
      ) : null}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="History image"
        wide
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}
      >
        {visibleUrl ? (
          <img
            src={visibleUrl}
            alt="Saved model content"
            className="max-h-[70vh] max-w-full object-contain"
          />
        ) : null}
      </Modal>
    </div>
  );
}
