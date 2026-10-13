import { clsx } from "clsx";
import {
  ChevronDown,
  FileText,
  ImageIcon,
  Search,
  Terminal,
} from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  type ContextEntry,
  composeContext,
  contextImageKey,
} from "@/features/members/activity-context";
import {
  type ActivityAction,
  type ActivityData,
  activityBinary,
  activityParts,
  activityRecord,
  activityText,
  clearLiveActivity,
  loadActivity,
  mergeActivityData,
  readableResult,
  readTextPage,
  savedTextKey,
  type TextReads,
} from "@/features/members/activity-data";
import { useLiveTool } from "@/features/members/live-tool";
import { useWindowState } from "@/features/members/window-cache";
import {
  type AgentHistoryRun,
  type Attachment,
  BackendError,
  backend,
  type HistoryBinary,
  type HistoryImage,
  type HistoryText,
  type HistoryValue,
} from "@/lib/backend";
import { formatTime, relativeTime } from "@/lib/format";

type ReadState = {
  data: ActivityData | null;
  loading: boolean;
  error: BackendError | null;
};
const TextReadContext = createContext<
  Record<number, { values: Record<string, HistoryText>; reads: TextReads }>
>({});
const ImageReadContext = createContext<
  | ((sequence: number, reference: HistoryBinary, image: HistoryImage) => void)
  | null
>(null);

function problem(value: unknown): BackendError {
  return value instanceof BackendError
    ? value
    : new BackendError(
        "history_invalid",
        value instanceof Error ? value.message : String(value),
      );
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
  const [textValues] = useWindowState<Record<string, HistoryText>>(
    `reader texts:${run.sequence}`,
    {},
  );
  const [textReads] = useWindowState<TextReads>(
    `reader text requests:${run.sequence}`,
    () => new Map(),
  );
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
            await loadActivity(
              agentId,
              run.sequence,
              abort.signal,
              (data) => {
                if (abort.signal.aborted || current !== generation.current)
                  return;
                const version = data.usageVersion;
                const revision = version?.live_versions?.find(
                  ([id, sequence]) =>
                    id === agentId && sequence === run.sequence,
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
              },
              textValues,
              textReads,
            );
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
  }, [agentId, clearTimer, run.sequence, onChange, textValues, textReads]);
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
        textReads.clear();
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
      textReads.clear();
      clearTimer();
      off();
    };
  }, [agentId, clearTimer, run.sequence, load, onChange, textReads]);
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
  const [images, setImages] = useWindowState<Record<string, HistoryImage>>(
    "conversation:images",
    {},
  );
  const [identities] = useWindowState(
    "conversation:identities",
    () => new Map<string, string>(),
  );
  const onImage = useCallback(
    (sequence: number, reference: HistoryBinary, image: HistoryImage) => {
      setImages((saved) => ({
        ...saved,
        [contextImageKey(sequence, reference)]: image,
      }));
    },
    [setImages],
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
  const textCaches = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(reads).flatMap(([sequence, state]) =>
          state.data
            ? [
                [
                  sequence,
                  {
                    values: state.data.textValues,
                    reads: state.data.textReads,
                  },
                ],
              ]
            : [],
        ),
      ),
    [reads],
  );
  const composition = composeContext(
    agentId,
    runs.flatMap((run) =>
      reads[run.sequence]?.data
        ? [reads[run.sequence].data as ActivityData]
        : [],
    ),
    images,
    identities,
  );
  const presentation: ReactNode[] = [];
  for (const run of runs) {
    const state = reads[run.sequence];
    const data = state?.data;
    const content = composition.entries.filter(
      (entry) => entry.sequence === run.sequence,
    );
    const reminder = content.some((entry) => entry.reminder);
    const empty =
      data?.complete &&
      data.requests.length > 0 &&
      !data.missing.length &&
      data.requests.every(
        (request) => data.contents[request.ordinal]?.request.input.total === 0,
      );
    const needsReminder =
      !reminder && ((run.request_count > 0 && !data?.complete) || empty);
    const status = needsReminder ? (
      <Bubble
        key={`${run.sequence}:reminder`}
        identity={`${run.sequence}:reminder`}
        side="trigger"
        timestamp={run.started_at}
        grouped={false}
        label="Reminder"
      >
        {empty ? (
          <p className="m-0">No saved reminder</p>
        ) : state?.error ? (
          <Retry
            error={state.error.message}
            loading={state.loading}
            label="Retry reminder"
            onRetry={() => onRetry(run.sequence)}
          />
        ) : !disconnected ? (
          <LoadingSkeleton label="Loading reminder">
            <Skeleton className="w-48 max-w-full" />
            <Skeleton className="w-32 max-w-full" />
          </LoadingSkeleton>
        ) : null}
      </Bubble>
    ) : null;
    let placed = false;
    for (const [index, entry] of content.entries()) {
      if (
        !placed &&
        !["Instructions", "Session context"].includes(entry.title ?? "")
      ) {
        if (status) presentation.push(status);
        placed = true;
      }
      presentation.push(
        <ConversationEntry
          key={entry.key}
          identity={entry.key}
          sequence={entry.sequence}
          timestamp={entry.action?.sent?.created_at ?? entry.timestamp ?? ""}
          kind={entry.value.part_kind}
          value={
            ["text", "thinking", "user-prompt", "system-prompt"].includes(
              String(entry.value.part_kind),
            ) && entry.value.content !== undefined
              ? entry.value.content
              : entry.value
          }
          title={entry.title}
          reminder={entry.reminder}
          action={entry.action}
          reply={entry.reply}
          workRecord={entry.workRecord}
          diagnostic={entry.diagnostic}
          emptyReminder={entry.reminder && entry.resolved.content === ""}
          saved={entry.saved}
          agentId={agentId}
          name={name}
          grouped={
            content[index - 1]?.reminder === entry.reminder &&
            !entry.title &&
            Math.abs(
              Date.parse(
                entry.action?.sent?.created_at ?? entry.timestamp ?? "",
              ) -
                Date.parse(
                  content[index - 1]?.action?.sent?.created_at ??
                    content[index - 1]?.timestamp ??
                    "",
                ),
            ) < 300_000
          }
          complete={data?.complete ?? false}
          running={data?.run.status === "running"}
        />,
      );
    }
    if (!placed && status) presentation.push(status);
    if (state?.error && !needsReminder)
      presentation.push(
        <Retry
          key={`${run.sequence}:error`}
          error={state.error.message}
          loading={state.loading}
          label="Retry activity"
          onRetry={() => onRetry(run.sequence)}
        />,
      );
    if (data?.run.error)
      presentation.push(
        <p
          key={`${run.sequence}:model error`}
          role="alert"
          className="text-sm text-danger wrap-anywhere"
        >
          {data.run.error}
        </p>,
      );
    if (!data && !state?.error && !disconnected)
      presentation.push(
        <LoadingSkeleton
          key={`${run.sequence}:loading`}
          label="Reading saved activity"
        >
          <Skeleton className="w-48 max-w-full" />
          <Skeleton className="w-32 max-w-full" />
        </LoadingSkeleton>,
      );
    else if (data && (state?.loading || data.run.status === "running"))
      presentation.push(
        <Spinner
          key={`${run.sequence}:loading`}
          label="Reading saved activity"
        />,
      );
    if (data?.complete && data.run.request_count === 0 && !data.legacy.length)
      presentation.push(
        <p key={`${run.sequence}:empty`} className="text-sm text-fg-muted">
          {data.run.status === "running"
            ? "Waiting for saved content"
            : "No saved content"}
        </p>,
      );
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
      <TextReadContext.Provider value={textCaches}>
        <ImageReadContext.Provider value={onImage}>
          {presentation}
        </ImageReadContext.Provider>
      </TextReadContext.Provider>
      {composition.missing.length ? (
        <p role="alert" className="text-sm text-warning wrap-anywhere">
          Historical content is incomplete: {composition.missing.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

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
      aria-label={label ?? (side === "trigger" ? "Reminder" : "Agent message")}
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
          {timestamp ? (
            <Tooltip label={formatTime(timestamp)}>
              <time dateTime={timestamp}>{relativeTime(timestamp)}</time>
            </Tooltip>
          ) : (
            <span>Start time unavailable</span>
          )}
          {target ? <span className="wrap-anywhere">{target}</span> : null}
          {label ? <span>{label}</span> : null}
        </div>
        <div
          className={clsx(
            "w-fit min-w-0 rounded-lg px-4 py-3 text-sm leading-body wrap-anywhere [@media(max-width:640px)]:max-w-full",
            side === "trigger"
              ? "ml-auto bg-surface-hover"
              : "border border-line bg-surface-raised",
          )}
        >
          {children}
        </div>
      </div>
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

const ConversationEntry = memo(function ConversationEntry({
  identity,
  sequence,
  timestamp,
  kind,
  value,
  title,
  reminder,
  action,
  reply,
  workRecord,
  diagnostic,
  emptyReminder,
  saved,
  agentId,
  name,
  grouped,
  complete,
  running,
}: Pick<
  ContextEntry,
  | "sequence"
  | "title"
  | "reminder"
  | "action"
  | "reply"
  | "workRecord"
  | "diagnostic"
  | "saved"
> & {
  identity: string;
  timestamp: string;
  kind: HistoryValue | undefined;
  value: HistoryValue;
  emptyReminder: boolean;
  agentId: number;
  name: string;
  grouped: boolean;
  complete: boolean;
  running: boolean;
}) {
  const body = (
    <>
      {saved === false ? (
        <p className="m-0 text-xs text-danger">Not saved</p>
      ) : null}
      {reply !== undefined ? (
        <LongContent identity={`${identity}:reply`}>
          <Prose>{reply}</Prose>
        </LongContent>
      ) : null}
      {action ? (
        <ToolAction
          agentId={agentId}
          sequence={sequence}
          action={action}
          complete={complete}
          running={running}
          replyDetails={reply !== undefined}
        />
      ) : reminder && complete && emptyReminder ? (
        <p className="m-0">No saved reminder</p>
      ) : (
        <Content
          agentId={agentId}
          sequence={sequence}
          identity={identity}
          value={value}
          markdown={kind === "text"}
          preview={title !== null}
        />
      )}
      {diagnostic ? (
        <p role="alert" className="text-sm text-danger wrap-anywhere">
          {diagnostic}
        </p>
      ) : null}
    </>
  );
  if (title && !reminder)
    return (
      <article
        aria-label={title}
        data-activity-anchor={identity}
        className="mt-4 w-full min-w-0 rounded-sm border border-line bg-surface-raised px-4 py-3"
      >
        <div className="mb-1 text-xs text-fg-muted">{title}</div>
        {body}
      </article>
    );
  return (
    <Bubble
      identity={identity}
      side={reminder ? "trigger" : "agent"}
      senderId={reminder ? undefined : agentId}
      name={reminder ? undefined : name}
      timestamp={timestamp}
      grouped={grouped}
      label={
        reminder
          ? "Reminder"
          : workRecord
            ? "Agent work record"
            : kind === "thinking"
              ? "Thinking"
              : undefined
      }
      target={
        action?.sent
          ? `Sent to Discussion ${action.sent.discussion_id}`
          : undefined
      }
    >
      {body}
    </Bubble>
  );
});

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
  replyDetails = false,
}: {
  agentId: number;
  sequence: number;
  action: ActivityAction;
  complete: boolean;
  running: boolean;
  replyDetails?: boolean;
}) {
  const { members, discussions } = useOrganization();
  const summary = actionSummary(
    action,
    new Map(
      discussions?.map((discussion) => [discussion.id, discussion.topic]),
    ),
    new Map(members?.map((member) => [member.id, member.name])),
  );
  const title = replyDetails ? "Message details" : summary;
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
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-surface-hover [@media(max-width:640px)]:max-w-full"
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
        <span className="min-w-0 flex-1 truncate [@media(max-width:640px)]:whitespace-normal [@media(max-width:640px)]:wrap-anywhere">
          {title}
        </span>
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
            value={action.args}
            references={action.args === action.value.args}
          />
          <Content
            agentId={agentId}
            sequence={sequence}
            identity={`${action.key}:call`}
            value={Object.fromEntries(
              Object.entries(action.value).filter(([key]) => key !== "args"),
            )}
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
              metadata={Object.fromEntries(
                Object.entries(result.value).filter(
                  ([key]) => key !== "content",
                ),
              )}
              structured={
                result.value.part_kind === "tool-return" ||
                result.value.part_kind === "retry-prompt"
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
  metadata,
  structured,
}: {
  agentId: number;
  sequence: number;
  identity: string;
  tool: string;
  value: HistoryValue;
  metadata: HistoryValue;
  structured: boolean;
}) {
  const textCache = useContext(TextReadContext)[sequence];
  const textValues = textCache?.values;
  const textReads = textCache?.reads;
  const signature = JSON.stringify(value);
  const [saved, setSaved] = useWindowState<ResultState>(
    `result:${sequence}:${identity}`,
    { signature, reading: value },
  );
  const current = useRef(saved);
  const [error, setError] = useState<BackendError | null>(null);
  const [loading, setLoading] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const previewText =
    typeof value === "string" ? value : activityText(value)?.value;
  const read =
    structured &&
    previewText !== undefined &&
    (previewText.trimStart().startsWith("{") ||
      previewText.trimStart().startsWith("["));
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
        textValues,
        textReads,
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
  }, [
    agentId,
    sequence,
    signature,
    value,
    read,
    ready,
    setSaved,
    identity,
    textValues,
    textReads,
  ]);
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
      <Content
        agentId={agentId}
        sequence={sequence}
        identity={`${identity}:metadata`}
        value={metadata}
        preview
      />
      {loading ? <Spinner label="Loading result" /> : null}
      {error ? (
        <Retry
          error={error.message}
          loading={loading}
          label="Retry result"
          onRetry={() => void load()}
        />
      ) : null}
      {error ? (
        <Content
          agentId={agentId}
          sequence={sequence}
          identity={`${identity}:unparsed`}
          value={saved.reading}
          preview
        />
      ) : null}
      {!read || ready ? (
        <>
          <Content
            agentId={agentId}
            sequence={sequence}
            identity={`${identity}:result`}
            value={read ? (saved.parsed ?? null) : value}
            references={!read}
            preview
          />
          {tool === "discussion" ? (
            <SavedAttachments value={read ? (saved.parsed ?? null) : value} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SavedAttachments({ value }: { value: HistoryValue }) {
  if (!activityRecord(value) || !Array.isArray(value.messages)) return null;
  const discussionId = value.id ?? value.discussion_id;
  if (typeof discussionId !== "number") return null;
  return value.messages.flatMap((message) => {
    if (
      !activityRecord(message) ||
      typeof message.id !== "number" ||
      !Array.isArray(message.attachments)
    )
      return [];
    const messageId = message.id;
    return message.attachments.flatMap((attachment) => {
      if (
        !activityRecord(attachment) ||
        typeof attachment.id !== "string" ||
        typeof attachment.name !== "string" ||
        typeof attachment.size !== "number" ||
        typeof attachment.media_type !== "string" ||
        typeof attachment.sha256 !== "string"
      )
        return [];
      return (
        <MessageAttachment
          key={`${message.id}:${attachment.id}`}
          discussionId={discussionId}
          messageId={messageId}
          attachment={attachment as unknown as Attachment}
          thumbnail
        />
      );
    });
  });
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
  references = true,
): { label: string; value: HistoryValue }[] {
  if (references && (activityText(value) || activityBinary(value)))
    return [{ label, value }];
  if (Array.isArray(value))
    return value.length
      ? value.flatMap((item, index) =>
          contentLeaves(item, `${label} ${index + 1}`.trim(), references),
        )
      : [{ label, value }];
  if (activityRecord(value))
    return Object.keys(value).length
      ? Object.entries(value).flatMap(([key, item]) =>
          contentLeaves(
            item,
            [label, key].filter(Boolean).join(" · "),
            references,
          ),
        )
      : [{ label, value }];
  return [{ label, value }];
}

const Content = memo(function Content({
  agentId,
  sequence,
  identity,
  value,
  markdown = false,
  preview = false,
  references = true,
}: {
  agentId: number;
  sequence: number;
  identity: string;
  value: HistoryValue;
  markdown?: boolean;
  preview?: boolean;
  references?: boolean;
}) {
  const leaves = contentLeaves(value, "", references);
  const hasImage = leaves.some(
    (leaf) => references && activityBinary(leaf.value) !== null,
  );
  const previewText = preview && !hasImage;
  const content = (
    <div className="flex min-w-0 flex-col gap-2">
      {leaves.map((leaf, index) => {
        const text = references ? activityText(leaf.value) : null;
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
          return (
            <div key={textKey} className="min-w-0">
              {leaf.label ? (
                <div className="text-xs text-fg-muted wrap-anywhere">
                  {leaf.label}
                </div>
              ) : null}
              {previewText ? (
                <LongContent identity={`${sequence}:${key}:${textKey}`} preview>
                  {body}
                </LongContent>
              ) : (
                body
              )}
            </div>
          );
        }
        const binary = references ? activityBinary(leaf.value) : null;
        if (binary) {
          const reference = binary;
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
            <pre
              data-value-type={
                leaf.value === null
                  ? "null"
                  : Array.isArray(leaf.value)
                    ? "array"
                    : typeof leaf.value
              }
              className="m-0 min-w-0 max-w-full overflow-x-auto font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere"
            >
              {leaf.value === null
                ? "null"
                : Array.isArray(leaf.value)
                  ? "[]"
                  : activityRecord(leaf.value)
                    ? "{}"
                    : String(leaf.value)}
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
  const textCache = useContext(TextReadContext)[sequence];
  const textValues = textCache?.values;
  const textReads = textCache?.reads;
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
        const cached = textValues?.[savedTextKey(sequence, current.current)];
        const page =
          cached &&
          cached.total_bytes === current.current.total_bytes &&
          cached.value.startsWith(current.current.value) &&
          !cached.has_more
            ? {
                ...cached,
                offset,
                value: cached.value.slice(current.current.value.length),
              }
            : await readTextPage(
                agentId,
                sequence,
                current.current,
                offset,
                textReads,
              );
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
        if (textValues && !current.current.has_more)
          textValues[savedTextKey(sequence, reference)] = current.current;
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
    [agentId, sequence, setSaved, textValues, textReads, reference],
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
  const onImage = useContext(ImageReadContext);
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
      onImage?.(sequence, address.current, image);
      setError(null);
    } catch (error) {
      if (token === generation.current) setError(problem(error));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [agentId, sequence, key, signature, setUrl, setSavedSignature, onImage]);
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
