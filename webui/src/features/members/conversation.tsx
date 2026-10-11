import { clsx } from "clsx";
import {
  ChevronDown,
  FileText,
  ImageIcon,
  Search,
  Terminal,
} from "lucide-react";
import {
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
  activityRecord,
  activityText,
  loadActivity,
  readableResult,
} from "@/features/members/activity-data";
import { useWindowState } from "@/features/members/activity-window";
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
  const load = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    onChange(run.sequence, (saved) => ({ ...saved, loading: true }));
    try {
      await loadActivity(agentId, run.sequence, abort.signal, (data) => {
        if (abort.signal.aborted) return;
        onChange(run.sequence, (saved) => ({
          ...saved,
          data: saved.data?.complete && !data.complete ? saved.data : data,
        }));
      });
      if (!abort.signal.aborted)
        onChange(run.sequence, (saved) => ({ ...saved, error: null }));
    } catch (error) {
      if (!abort.signal.aborted)
        onChange(run.sequence, (saved) => ({
          ...saved,
          error: problem(error),
        }));
    } finally {
      if (!abort.signal.aborted)
        onChange(run.sequence, (saved) => ({ ...saved, loading: false }));
    }
  }, [agentId, run.sequence, onChange]);
  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        request.current?.abort();
        onChange(run.sequence, (saved) => ({ ...saved, loading: false }));
      }
      if (
        event.type === "connection.restored" ||
        (event.type.startsWith("turn.") &&
          event.agent_id === agentId &&
          event.sequence === run.sequence)
      )
        void load();
    });
    return () => {
      request.current?.abort();
      off();
    };
  }, [
    agentId,
    run.sequence,
    run.status,
    run.last_saved_at,
    run.request_count,
    load,
    onChange,
  ]);
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
        return unit.source ? (
          <MessageBubble
            key={unit.key}
            unit={unit}
            agentId={agentId}
            grouped={grouped}
            onMessage={onMessage}
          />
        ) : (
          <Bubble
            key={unit.key}
            identity={unit.key}
            side={unit.side}
            senderId={unit.senderId}
            name={unit.side === "agent" ? name : undefined}
            timestamp={unit.timestamp}
            grouped={grouped}
            label={unit.workRecord ? "Agent work record" : undefined}
          >
            {unit.action ? (
              <ToolAction
                agentId={agentId}
                sequence={unit.sequence}
                action={unit.action}
                complete={reads[unit.sequence]?.data?.complete ?? false}
                running={reads[unit.sequence]?.data?.run.status === "running"}
              />
            ) : null}
            {unit.text !== undefined ? (
              <Content
                agentId={agentId}
                sequence={unit.sequence}
                identity={unit.key}
                value={unit.text}
                markdown
              />
            ) : null}
            {unit.notice === "Loading trigger information" &&
            !backend.disconnected ? (
              <LoadingSkeleton label={unit.notice}>
                <Skeleton className="w-48 max-w-full" />
                <Skeleton className="w-32 max-w-full" />
              </LoadingSkeleton>
            ) : unit.notice ? (
              <p className="m-0 wrap-anywhere">{unit.notice}</p>
            ) : null}
            {unit.state?.error ? (
              <Retry
                error={unit.state.error.message}
                loading={unit.state.loading}
                label="Retry activity"
                onRetry={() => {
                  const retry = retries.current.get(unit.sequence);
                  if (!retry) throw new Error("Activity retry is unavailable");
                  retry();
                }}
              />
            ) : null}
            {unit.key.endsWith(":state") &&
            !unit.state?.data &&
            !unit.state?.error &&
            !backend.disconnected ? (
              <LoadingSkeleton label="Reading saved activity">
                <Skeleton className="w-48 max-w-full" />
                <Skeleton className="w-32 max-w-full" />
              </LoadingSkeleton>
            ) : unit.state?.data &&
              (unit.state.loading ||
                reads[unit.sequence]?.data?.run.status === "running") ? (
              <Spinner label="Reading saved activity" />
            ) : null}
          </Bubble>
        );
      })}
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
  onMessage,
}: {
  unit: ConversationUnit;
  agentId: number;
  grouped: boolean;
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
      {!saved && !error && !backend.disconnected ? (
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
  const [outcomes, setOutcomes] = useWindowState<
    Record<string, { signature: string; failed: boolean }>
  >(`outcomes:${sequence}:${action.key}`, {});
  const onResult = useCallback(
    (identity: string, signature: string, value: HistoryValue) => {
      setOutcomes((saved) => ({
        ...saved,
        [identity]: { signature, failed: failedOutput(value) },
      }));
    },
    [setOutcomes],
  );
  const failed = action.results.some(
    (result) =>
      result.value.part_kind === "retry-prompt" ||
      failedOutput(result.value.content) ||
      (outcomes[result.key]?.signature ===
        JSON.stringify(result.value.content) &&
        outcomes[result.key].failed),
  );
  const Icon =
    tool === "run"
      ? Terminal
      : tool.startsWith("view_")
        ? ImageIcon
        : tool === "web_search"
          ? Search
          : FileText;
  const status = failed
    ? "Failed"
    : action.results.length
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
          {action.results.map((result) => (
            <ToolResult
              key={result.key}
              agentId={agentId}
              sequence={sequence}
              identity={result.key}
              tool={tool}
              value={result.value.content}
              onResult={onResult}
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
          {!action.results.length ? (
            <p className="m-0 text-fg-muted">{status}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function failedOutput(value: HistoryValue): boolean {
  return (
    activityRecord(value) &&
    ((value.error !== undefined && value.error !== null) ||
      (typeof value.exit_code === "number" && value.exit_code !== 0))
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
  onResult,
}: {
  agentId: number;
  sequence: number;
  identity: string;
  tool: string;
  value: HistoryValue;
  structured: boolean;
  onResult: (identity: string, signature: string, value: HistoryValue) => void;
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
      onResult(identity, signature, parsed);
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
    onResult,
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
    const measure = () => setLong(node.scrollHeight > (preview ? 32 : 300));
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
              ? "max-h-8 overflow-hidden"
              : "max-h-[300px] overflow-hidden"),
        )}
      >
        <div ref={root} className="min-w-0">
          {children}
        </div>
        {!expanded && long && !preview ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-surface-raised to-transparent"
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

function Content({
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
  return (
    <LongContent
      identity={`${sequence}:${identity}`}
      preview={preview && !hasImage}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {leaves.map((leaf, index) => {
          const text = activityText(leaf.value);
          const key = `${identity}:${leaf.label || index}`;
          if (text)
            return (
              <TextContent
                key={`${text.source}:${text.request_ordinal}:${text.message_index}:${JSON.stringify(text.path)}`}
                agentId={agentId}
                sequence={sequence}
                reference={text}
                markdown={markdown}
              />
            );
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
          return (
            <div key={key} className="min-w-0">
              {leaf.label ? (
                <div className="text-xs text-fg-muted wrap-anywhere">
                  {leaf.label}
                </div>
              ) : null}
              {markdown && typeof leaf.value === "string" ? (
                <Prose>{leaf.value}</Prose>
              ) : (
                <pre className="m-0 min-w-0 max-w-full overflow-x-auto font-mono text-xs leading-body whitespace-pre-wrap wrap-anywhere">
                  {leaf.value === null ? "null" : String(leaf.value)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </LongContent>
  );
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
  const current = useRef(saved);
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
      !previous.value.startsWith(reference.value) ||
      previous.next_offset > reference.total_bytes
    ) {
      generation.current += 1;
      busy.current = false;
      interrupted.current = null;
      current.current = reference;
      setSaved(reference);
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
  }, [reference, setSaved]);
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
        <Prose>{saved.value}</Prose>
      ) : (
        <pre className="m-0 max-w-full overflow-x-auto text-xs whitespace-pre-wrap wrap-anywhere">
          {saved.value}
        </pre>
      )}
      {error ? (
        <Retry
          error={error.message}
          loading={loading}
          label="Retry text"
          onRetry={() => void load()}
        />
      ) : saved.has_more ? (
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
        reference,
      );
      if (token !== generation.current) return;
      setUrl(`data:${image.media_type};base64,${image.data}`);
      setError(null);
    } catch (error) {
      if (token === generation.current) setError(problem(error));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [agentId, sequence, reference, setUrl]);
  useEffect(() => {
    if (!url) void load();
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
  }, [load, url]);
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
      {url && !error ? (
        <button
          type="button"
          aria-label="Open history image"
          className="max-w-full cursor-zoom-in overflow-hidden rounded-sm"
          onClick={() => setOpen(true)}
        >
          <img
            src={url}
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
        {url ? (
          <img
            src={url}
            alt="Saved model content"
            className="max-h-[70vh] max-w-full object-contain"
          />
        ) : null}
      </Modal>
    </div>
  );
}
