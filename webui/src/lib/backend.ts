export type UsageFilters = {
  contributions_only?: boolean;
  agent_id?: number | null;
  model_key?: string | null;
  coverage?: string | null;
  start_at?: string | null;
  end_at?: string | null;
};

export type UsageMetrics = {
  records: number;
  input_tokens: string | null;
  output_tokens: string | null;
  total_tokens: string | null;
  requests: string | null;
  input_known: number;
  output_known: number;
  total_known: number;
  requests_known: number;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cache_read_known: number;
  cache_write_known: number;
  estimated_cost: string | null;
  cost_known: number;
  last_active: string | null;
  model_count: number;
};

export type UsageVersion = {
  runtime_epoch?: string | null;
  live_versions?: [number, number, number][];
};

export type UsageRecord = {
  record_id: string;
  source_kind: "request" | "turn_summary";
  agent_id: number;
  agent_name: string;
  agent_name_source: string;
  agent_deleted: boolean;
  sequence: number;
  ordinal: number | null;
  request_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  coverage: string;
  model_key: string;
  model: Record<string, string | number | null>;
  model_identity_source: string;
  field_source: string;
  input_tokens: string | null;
  output_tokens: string | null;
  total_tokens: string | null;
  requests: string | null;
  cost: string | null;
  cost_source: string;
  currency: string;
  partial_history: boolean;
  saved?: boolean;
  observation_source?: "runtime" | "persisted";
};

export type UsageQuery = UsageFilters &
  UsageVersion & {
    limit?: number;
    cursor?: string | null;
    dataset_revision?: number;
    initialization_version?: number;
    anchor?: string;
  };

export type UsageIndexState = {
  version: number;
  ready: number;
  revision: number;
  request_checkpoint: number;
  turn_checkpoint: number;
  processed_requests: number;
  processed_turns: number;
  error: string | null;
};

export type UsageInitialization = {
  status: "initializing";
  filters: UsageFilters;
  index: UsageIndexState;
};

export type UsageQueryResult = UsageInitialization | UsageResult;

export type UsageResult = UsageVersion & {
  status: "ready";
  filters: UsageFilters;
  dataset_revision: number;
  index: UsageIndexState;
  summary: UsageMetrics;
  daily: (Pick<
    UsageMetrics,
    | "records"
    | "input_tokens"
    | "output_tokens"
    | "total_tokens"
    | "requests"
    | "input_known"
    | "output_known"
    | "total_known"
    | "requests_known"
  > & { date: string })[];
  coverage: Record<string, number>;
  groups: {
    agent_id: (UsageMetrics & { agent_id: number })[];
    model_key: (UsageMetrics & { model_key: string })[];
  };
  records: UsageRecord[];
  has_more: boolean;
  next_cursor: string | null;
  previous_cursor: string | null;
  agents: { id: number; name: string; deleted: number }[];
  models: { key: string; model: UsageRecord["model"] }[];
};

export type UsageDetail = UsageRecord &
  UsageVersion & {
    dataset_revision: number;
    usage_json: string;
    turn_summary: Record<string, unknown> | null;
    turn_summary_json: string | null;
    summary_mismatch: boolean;
    traceable_requests: number;
    provider_field_presence: string;
  };

export type Thinking =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "budget";

export type AgentModelConfig = {
  model_id: string | null;
  thinking: Thinking | null;
};

export type ProviderConfig = {
  id: string;
  name: string;
  api_type: string;
  base_url: string;
  api_key_set: boolean;
  enabled: boolean;
  extra_body?: Record<string, HistoryValue>;
};

export type RegisteredModel = {
  id: string;
  provider_id: string;
  name: string;
  model: string;
  enabled: boolean;
  thinking_budget_tokens: number | null;
  thinking_options: Thinking[];
};

export type ModelCatalog = {
  version: 2;
  providers: ProviderConfig[];
  models: RegisteredModel[];
  default_model_id: string | null;
  default_thinking: Thinking;
  agent_configs: Record<string, AgentModelConfig>;
};

export type AgentStatus = {
  state: "idle" | "running" | "paused" | "blocked" | "error";
  pause_requested?: boolean;
  reasons?: { code: string; message: string; recovery: string }[];
  error?: string | null;
  scheduler_stopped?: string | null;
};

export type Member = AgentStatus & {
  id: number;
  type: "human" | "agent";
  name: string;
  tokens?: number | null;
  usage_metrics?: UsageMetrics | null;
  usage_index_ready?: boolean;
};

export type DiscussionSummary = {
  id: number;
  topic: string;
  member_ids: number[];
  archived: boolean;
  unread: number;
  mentions: number;
};

export type MessageMention = {
  member_id: number;
  position: number;
  length: number;
};

export type Attachment = {
  id: string;
  name: string;
  size: number;
  media_type: string;
  sha256: string;
  width: number | null;
  height: number | null;
};

export type UploadRecord = {
  id: string;
  state:
    | "reserved"
    | "receiving"
    | "ready"
    | "attached"
    | "deleting"
    | "expired";
  expires_at: number;
};

export type Message = {
  id: number;
  sender_id: number;
  sender_name: string;
  body: string;
  mentions: MessageMention[];
  attachments: Attachment[];
  created_at: string;
};

export type DiscussionDetail = {
  id: number;
  topic: string;
  members: { id: number; name: string }[];
  total_messages: number;
  archived: boolean;
  read_through: number;
  messages: Message[];
};

export type ReadSection =
  | "messages"
  | "members"
  | "awaiting_ack"
  | "acknowledged"
  | "mentions"
  | "attachments";

export type DiscussionReadRequest = {
  action?: "read";
  discussion_id?: number;
  message_id?: number | null;
  before?: number | null;
  after?: number | null;
  limit?: number | null;
  max_chars?: number | null;
  section?: ReadSection;
  cursor?: string | null;
};

export type ArrayReadInfo = {
  total: number;
  complete: boolean;
  realtime?: boolean;
  continuation: DiscussionReadRequest | null;
};

export type ReadMessage = Message & {
  body_offset: number;
  body_end: number;
  body_length: number;
  body_complete: boolean;
  mention_position_scope: "complete_body";
  mentions_info: ArrayReadInfo;
  attachments_info: ArrayReadInfo;
};

export type DiscussionReadBase = {
  id: number;
  topic: string;
  archived: boolean;
  read_through: number;
  total_messages: number;
  continuations: DiscussionReadRequest[];
};

export type DiscussionReadMessages = DiscussionReadBase & {
  section: "messages";
  messages: ReadMessage[];
  members: { id: number; name: string }[];
  members_info: ArrayReadInfo;
  awaiting_ack: number[];
  acknowledged: number[];
  awaiting_ack_count: number;
  acknowledged_count: number;
  awaiting_ack_info: ArrayReadInfo;
  acknowledged_info: ArrayReadInfo;
  ack_scope: "returned_messages";
  direction: "before" | "after";
  snapshot_max_id: number;
  context_target: number | null;
};

export type DiscussionReadMetadata = DiscussionReadBase & {
  total: number;
  offset: number;
  complete: boolean;
  realtime: boolean;
} & (
    | { section: "members"; members: { id: number; name: string }[] }
    | { section: "awaiting_ack"; awaiting_ack: number[] }
    | { section: "acknowledged"; acknowledged: number[] }
    | {
        section: "mentions";
        mentions: MessageMention[];
        message_id: number;
        sender_id: number;
        sender_name: string;
      }
    | {
        section: "attachments";
        attachments: Attachment[];
        message_id: number;
        sender_id: number;
        sender_name: string;
      }
  );

export type DiscussionReadResult =
  | DiscussionReadMessages
  | DiscussionReadMetadata;

export type DiscussionPage = {
  id: number;
  messages: Message[];
  read_through: number;
  latest_id: number;
  first_unread_id?: number | null;
  has_before: boolean;
  has_after: boolean;
  previous_sender_id: number | null;
  metadata?: {
    topic: string;
    archived: boolean;
    members: { id: number; name: string }[];
  };
};

export type PageRequest = {
  entry?: boolean;
  before?: number;
  after?: number;
  limit?: number;
  metadata?: boolean;
};

export type GenerationKey = {
  agent_id: number;
  sequence: number;
  ordinal: number;
  part_index: number;
  request_id: string;
  run_id: string;
};

export type GenerationPart = {
  tool_name?: string | null;
  tool_call_id?: string | null;
  key: GenerationKey;
  part_kind: string;
  revision: number;
  status: "generating" | "completed" | "failed" | "interrupted";
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscussionPreview = {
  preview_id: string;
  key: GenerationKey;
  discussion_id: number | null;
  revision: number;
  status: "generating" | "sending" | "sent" | "failed" | "interrupted";
  error: string | null;
  message_id: number | null;
  created_at: string;
  updated_at: string;
};

export type GenerationTextPage = {
  revision: number;
  offset: number;
  next_offset: number;
  total_bytes: number;
  value: string;
  has_more: boolean;
};

export type DiscussionPreviewPage = {
  discussion_id: number;
  previews: DiscussionPreview[];
  has_more: boolean;
  next_before: [string, string] | null;
};

export type DiscussionPreviewRead = {
  preview: DiscussionPreview;
  body: GenerationTextPage;
};

export type GenerationPartPage = {
  agent_id: number;
  sequence: number;
  ordinal: number;
  parts: GenerationPart[];
  has_more: boolean;
  next_after: number | null;
};

export type GenerationField = "json" | "content" | "args";

export type GenerationPartText = GenerationTextPage & {
  key: GenerationKey;
  field: GenerationField;
};

export type TurnEffect = { ordinal: number; tool: string; summary: string };

export type HistoryReminder = { discussion_id: number; message_id: number };

export type HistoryValue =
  | null
  | boolean
  | number
  | string
  | HistoryValue[]
  | { [key: string]: HistoryValue };

export type HistoryMessages = {
  messages: HistoryValue[];
  offset: number;
  total: number;
  total_bytes?: number;
  next_offset?: number;
  has_more: boolean;
  saved?: boolean;
};

export type LiveTool = {
  part_index: number;
  tool_call_id: string;
  tool_name: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  started_at: string | null;
  completed_at: string | null;
  saved: boolean;
  has_result: boolean;
  content_version?: string | null;
};

export type LivePage = {
  runtime_epoch: string;
  turn: {
    agent_id: number;
    sequence: number;
    run_id: string;
    live_revision: number;
    status: string;
    error: string | null;
    requests: {
      ordinal: number;
      request_id: string;
      started_at: string;
      response_saved?: boolean;
      has_response?: boolean;
      response_version?: string | null;
      tools: LiveTool[];
      tools_has_more: boolean;
      tools_next_after: number | null;
    }[];
    has_more: boolean;
    next_after: number | null;
  } | null;
};

export type HistoryBinary = {
  kind: "binary";
  source: "run" | "input" | "response" | "related" | "live";
  request_ordinal?: number;
  part_index?: number;
  runtime_epoch?: string;
  content_source?: "tool" | "response";
  content_version?: string | null;
  message_index: number;
  path: (string | number)[];
  media_type: string;
  size: number;
  identifier: string | null;
};

export type HistoryText = {
  kind: "text";
  source:
    | "history"
    | "run"
    | "input"
    | "response"
    | "related"
    | "live"
    | "parameters"
    | "settings"
    | "model";
  request_ordinal?: number;
  part_index?: number;
  runtime_epoch?: string;
  content_source?: "tool" | "response";
  content_version?: string | null;
  message_index: number;
  path: (string | number)[];
  offset: number;
  next_offset: number;
  total_bytes: number;
  value: string;
  has_more: boolean;
};

export type AgentHistoryRun = {
  reminded?: HistoryReminder[];
  sequence: number;
  run_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  last_saved_at: string | null;
  window_number: number | null;
  window_reset_at: string | null;
  window_reason: string | null;
  request_count: number;
  usage: string | null;
  usage_metrics?: UsageMetrics | null;
  error: string | null;
  legacy: boolean;
};

export type AgentHistoryRequestSummary = {
  ordinal: number;
  request_id: string;
  run_id: string;
  window_number: number | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  streaming: boolean;
  input_length: number;
  parameters_length: number;
  settings_length: number;
  model_length: number;
  response_length: number;
  input_count: number;
  response_count: number;
  related_count: number;
  error: string | null;
};

export type AgentWindowEvent = {
  number: number;
  since_sequence: number;
  reset_at: string | null;
  reason: string | null;
};

export type AgentHistoryWindow = {
  number: number;
  since_sequence: number | null;
  started_at: string | null;
  start_reason: string | null;
  ended_at: string | null;
  end_reason: string | null;
  is_current: boolean;
};

export type AgentHistoryWindows = {
  agent_id: number;
  current_window_number: number;
  windows: AgentHistoryWindow[];
  has_unassigned: boolean;
  has_before: boolean;
  next_before: number | null;
};

export type AgentHistoryPage = {
  agent_id: number;
  window_number?: number | null;
  runs: AgentHistoryRun[];
  windows: AgentWindowEvent[];
  has_before: boolean;
  next_before: number | null;
  windows_has_more: boolean;
  windows_next_after: number | null;
};

export type AgentHistoryRead = {
  agent_id: number;
  run: AgentHistoryRun;
  windows: AgentWindowEvent[];
  windows_has_more: boolean;
  windows_next_after: number | null;
  requests: AgentHistoryRequestSummary[];
  requests_has_more: boolean;
  requests_next_after: number | null;
  messages: HistoryMessages;
  missing: string[];
  usage_version?: UsageVersion & {
    dataset_revision: number;
    index: UsageIndexState;
  };
  request?: {
    summary: AgentHistoryRequestSummary;
    input: HistoryMessages;
    parameters: HistoryText;
    settings: HistoryText;
    model: HistoryText;
    response: HistoryMessages | null;
    response_saved?: boolean;
    observation?: {
      runtime_epoch: string;
      live_revision: number;
      request_id: string;
    };
    related: HistoryMessages;
  };
};

export type HistoryImage = {
  media_type: string;
  size: number;
  identifier: string | null;
  data: string;
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  requests: number;
  total_tokens: number;
};

export type FoundMessage = {
  discussion_id: number;
  id: number;
  sender_name: string;
  body: string;
  mentions: MessageMention[];
};

export type LibraryEntry = {
  path: string;
  kind: "file" | "directory";
  size: number;
  modified_at: string;
};

export type LibraryDocument = { path: string; content: string; hash: string };

type LibraryWriteResult =
  | (LibraryEntry & { hash: string; conflict?: false })
  | {
      conflict: true;
      path: string;
      current_hash: string;
      current_content: string;
    };

export type BackendEvent = { type: string } & Record<string, unknown>;

export class BackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transport = false,
    readonly operation: string | null = null,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export type Frame = {
  type: string;
  id?: number;
  result?: unknown;
  error?: { code: string; message: string };
} & Record<string, unknown>;

export type Connection = { url: string } | { error: string };

export type Socket = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
};

const REQUEST_TIMEOUT = 60_000;
const READ_METHODS = new Set([
  "ping",
  "organization.get",
  "discussion.list",
  "discussion.page",
  "discussion.previews",
  "discussion.preview",
  "discussion.preview.text",
  "discussion.search",
  "usage.query",
  "usage.read",
  "agent.live",
  "agent.live.read",
  "agent.history",
  "agent.history.windows",
  "agent.history.read",
  "agent.history.text",
  "agent.history.image",
  "agent.generation.parts",
  "agent.generation.text",
  "library.list",
  "library.read",
  "workspace.list",
  "workspace.read",
  "settings.get",
  "settings.list_models",
]);

function unconfirmed(method: string): BackendError {
  return new BackendError(
    "unconfirmed",
    method === "discussion.send"
      ? "Your message may have been sent. Check the discussion before sending it again."
      : "The operation may have completed. Check the current state before trying again.",
    true,
    method,
  );
}

const DIAGNOSIS_TIMEOUT = 5_000;

export async function diagnoseConnection(url: string): Promise<BackendError> {
  const failure = new BackendError(
    "connection_failed",
    "Check that Fora is running, then reconnect.",
    true,
  );
  const endpoint = new URL(url);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  let response: Response;
  try {
    response = await fetch(endpoint, {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(DIAGNOSIS_TIMEOUT),
    });
    await response.body?.cancel();
  } catch {
    return failure;
  }
  return failure;
}

export function connectionFrom(search: string, origin: string): Connection {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error !== null) return { error };
  const ws =
    params.get("ws") ??
    `${origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/ws`;
  const url = new URL(ws);
  return { url: url.toString() };
}

export type Resolved = {
  connection: Connection;
  remember: string | null;
  scrub: boolean;
};

export function resolveConnection(
  search: string,
  origin: string,
  remembered: string | null,
): Resolved {
  const params = new URLSearchParams(search);
  if (params.has("error")) {
    return {
      connection: connectionFrom(search, origin),
      remember: null,
      scrub: false,
    };
  }
  if (params.has("token") || params.has("ws")) {
    const connection = connectionFrom(search, origin);
    return {
      connection,
      remember: "url" in connection ? connection.url : null,
      scrub: true,
    };
  }
  if (remembered) {
    return { connection: { url: remembered }, remember: null, scrub: false };
  }
  return {
    connection: connectionFrom(search, origin),
    remember: null,
    scrub: false,
  };
}

export function withoutConnectionParams(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("ws");
  url.searchParams.delete("token");
  return url.toString();
}

const STORAGE_KEY = "fora.connection";

function recall(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    throw new BackendError(
      "storage_read_failed",
      "Could not read browser session storage. Allow session storage, then reopen Fora from its original launch entry.",
      true,
    );
  }
}

function remember(url: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, url);
  } catch {
    throw new BackendError(
      "storage_write_failed",
      "Could not save the connection in browser session storage. Allow session storage, then reopen Fora from its original launch entry.",
      true,
    );
  }
}

function pageConnection(): Connection {
  const search = location.search;
  const params = new URLSearchParams(search);
  if (params.has("token") || params.has("ws")) {
    try {
      history.replaceState(
        history.state,
        "",
        withoutConnectionParams(location.href),
      );
    } catch {
      throw new BackendError(
        "url_cleanup_failed",
        "Could not clear connection parameters from the address. Close this page and reopen Fora from its original launch entry.",
        true,
      );
    }
  }
  const remembered = recall();
  let resolved: Resolved;
  try {
    resolved = resolveConnection(search, location.origin, remembered);
  } catch {
    throw new BackendError(
      "invalid_connection",
      "The connection address is invalid. Reopen Fora from its original launch entry.",
      true,
    );
  }
  if (resolved.remember) remember(resolved.remember);
  return resolved.connection;
}

function browserSocket(url: string): Socket {
  return new WebSocket(url);
}

export class Backend {
  #locate: () => Connection;
  #socket: (url: string) => Socket;
  #nextId = 1;
  #connectionUrl: URL | null = null;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: BackendEvent) => void>();
  #ready: Promise<Socket> | null = null;
  #activeSocket: Socket | null = null;
  #generation = 0;
  #reconnecting: Promise<void> | null = null;
  #automaticAttempted = false;
  #closed: BackendError | null = null;
  #rejectConnection: ((error: BackendError) => void) | null = null;
  #failures = new Set<(error: BackendError) => void>();
  #usageIndex: { generation: number; value: UsageIndexState } | null = null;
  #usageAdvancing = new Map<
    number | undefined,
    {
      generation: number;
      operation: Promise<UsageIndexState>;
    }
  >();

  constructor(
    locate: () => Connection = pageConnection,
    socket: (url: string) => Socket = browserSocket,
  ) {
    this.#locate = locate;
    this.#socket = socket;
  }

  async connect(): Promise<void> {
    await this.#open();
  }

  async voiceUrl(): Promise<string> {
    const socket = await this.#open();
    if (this.#closed) throw this.#closed;
    if (socket !== this.#activeSocket || this.#connectionUrl === null)
      throw new BackendError("connection_changed", "Connection changed.", true);
    const url = new URL(this.#connectionUrl);
    url.pathname = "/voice";
    return url.toString();
  }

  reconnect(automatic = false): Promise<void> {
    if (this.#reconnecting) return this.#reconnecting;
    if (
      !this.#closed ||
      (automatic &&
        (this.#automaticAttempted ||
          !["disconnected", "connection_failed", "connection_timeout"].includes(
            this.#closed.code,
          )))
    )
      return Promise.resolve();
    this.#automaticAttempted = true;
    this.#closed = null;
    const generation = this.#generation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.#reconnecting = operation;
    this.#emit({ type: "connection.reconnecting" });
    this.#open()
      .then(() => {
        if (generation !== this.#generation)
          throw new BackendError(
            "connection_changed",
            "Connection changed while reconnecting.",
            true,
          );
        this.#reconnecting = null;
        this.#automaticAttempted = false;
        this.#emit({ type: "connection.restored" });
      })
      .finally(() => {
        if (this.#reconnecting === operation) this.#reconnecting = null;
      })
      .then(resolve, reject);
    return operation;
  }

  #emit(event: BackendEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #attach(): Promise<Socket> {
    const connection = this.#locate();
    if ("error" in connection)
      throw new BackendError("startup_failed", connection.error, true);
    this.#connectionUrl = new URL(connection.url);
    return new Promise<Socket>((resolve, reject) => {
      const socket = this.#socket(connection.url);
      const generation = this.#generation;
      this.#activeSocket = socket;
      let opened = false;
      socket.onopen = () => {
        if (generation !== this.#generation) return;
        opened = true;
        resolve(socket);
      };
      socket.onmessage = (event) => {
        if (generation !== this.#generation) return;
        let frame: Frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          this.#disconnect(
            new BackendError(
              "protocol_error",
              "Fora received an invalid WebSocket message. Reopen Fora to reconnect. Check pending operations before trying them again.",
              true,
            ),
          );
          return;
        }
        this.#receive(frame);
      };
      socket.onerror = () => {};
      socket.onclose = (event) => {
        if (generation !== this.#generation) return;
        console.info("WebSocket closed", {
          code: event.code,
          reason:
            event.reason === "keepalive ping timeout" || event.reason === ""
              ? event.reason
              : "[redacted]",
          wasClean: event.wasClean,
        });
        if (opened) {
          this.#disconnect(
            new BackendError(
              "disconnected",
              "Connection lost. Reconnect to continue.",
              true,
            ),
          );
          return;
        }
        void diagnoseConnection(connection.url).then((error) => {
          if (generation === this.#generation) reject(error);
        });
      };
    });
  }

  #open(): Promise<Socket> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#ready) return this.#ready;
    const generation = this.#generation;
    let resolve!: (socket: Socket) => void;
    let reject!: (error: BackendError) => void;
    const ready = new Promise<Socket>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.#ready = ready;
    const timer = setTimeout(() => {
      this.#disconnect(
        new BackendError(
          "connection_timeout",
          "Connection timed out. Reconnect to try again.",
          true,
        ),
      );
    }, REQUEST_TIMEOUT);
    this.#rejectConnection = (error) => {
      clearTimeout(timer);
      this.#rejectConnection = null;
      reject(error);
    };
    const fail = (error: unknown) => {
      if (generation !== this.#generation) return;
      this.#disconnect(
        error instanceof BackendError
          ? error
          : new BackendError(
              "connection_failed",
              "Could not open the connection. Reopen the Fora link.",
              true,
            ),
      );
    };
    let attached: Promise<Socket>;
    try {
      attached = this.#attach();
    } catch (error) {
      fail(error);
      return ready;
    }
    attached.then((socket) => {
      if (generation !== this.#generation) return;
      clearTimeout(timer);
      this.#rejectConnection = null;
      resolve(socket);
    }, fail);
    return ready;
  }

  get disconnected(): boolean {
    return this.#closed !== null;
  }

  get reconnecting(): boolean {
    return this.#reconnecting !== null;
  }

  onFailure(listener: (error: BackendError) => void): () => void {
    this.#failures.add(listener);
    if (this.#closed) listener(this.#closed);
    return () => this.#failures.delete(listener);
  }

  reportFailure = (error: unknown): void => {
    if (this.#closed || (error instanceof BackendError && error.transport))
      return;
    this.#notify(
      error instanceof BackendError
        ? error
        : new BackendError(
            "request_failed",
            error instanceof Error ? error.message : String(error),
          ),
    );
  };

  #notify(error: BackendError): void {
    for (const listener of this.#failures) listener(error);
  }

  #disconnect(error: BackendError): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#generation += 1;
    this.#ready = null;
    this.#reconnecting = null;
    this.#rejectConnection?.(error);
    const socket = this.#activeSocket;
    this.#activeSocket = null;
    socket?.close();
    for (const pending of this.#pending.values()) {
      const failure = READ_METHODS.has(pending.method)
        ? error
        : unconfirmed(pending.method);
      pending.reject(failure);
      if (failure !== error) this.#notify(failure);
    }
    this.#pending.clear();
    this.#notify(error);
    this.#emit({ type: "connection.closed", error });
  }

  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #receive(frame: Frame): void {
    if (this.#closed) return;
    if (frame.type === "response" && typeof frame.id === "number") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      if (frame.error) {
        pending.reject(new BackendError(frame.error.code, frame.error.message));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    for (const listener of this.#listeners) listener(frame as BackendEvent);
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const socket = await this.#open();
    if (this.#closed) throw this.#closed;
    if (socket !== this.#activeSocket)
      throw new BackendError(
        "connection_changed",
        "Connection changed. Request was not sent.",
        true,
      );
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = READ_METHODS.has(method)
          ? new BackendError(
              "timeout",
              "Request timed out. Try reading again.",
              true,
              method,
            )
          : unconfirmed(method);
        const pending = this.#pending.get(id);
        if (!pending) return;
        pending.reject(error);
        this.#notify(error);
      }, REQUEST_TIMEOUT);
      const finish = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
      };
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          finish();
          resolve(value as T);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        const error = new BackendError(
          "send_failed",
          "Could not send request. Check before retrying.",
          true,
        );
        this.#pending.get(id)?.reject(error);
        this.#notify(error);
      }
    });
  }

  organization() {
    return this.call<{
      id: number;
      uuid: string;
      members: Member[];
      human_id: number;
      token_limit: number | null;
      usage_version?: UsageVersion & {
        dataset_revision: number;
        index: UsageIndexState;
      };
    }>("organization.get");
  }

  modelCatalog() {
    return this.call<ModelCatalog>("settings.get", { section: "model" });
  }

  configureModel(action: string, id: string | number | null, values = {}) {
    return this.call<ModelCatalog>("settings.update", {
      section: "model",
      values: { action, id, values },
    });
  }

  createAgent(name: string, model_config?: AgentModelConfig) {
    return this.call<Member>("organization.create_agent", {
      name,
      model_config,
    });
  }

  renameMember(member_id: number, name: string) {
    return this.call<Member>("organization.rename_member", { member_id, name });
  }

  pauseAgent(agent_id: number) {
    return this.call<Member>("organization.pause_agent", { agent_id });
  }

  resumeAgent(agent_id: number) {
    return this.call<Member>("organization.resume_agent", { agent_id });
  }

  deleteAgent(agent_id: number) {
    return this.call<{ id: number }>("organization.delete_agent", { agent_id });
  }

  discussions(include_archived = false) {
    return this.call<DiscussionSummary[]>("discussion.list", {
      include_archived,
    });
  }

  createDiscussion(topic: string, member_ids: number[]) {
    return this.call<DiscussionSummary>("discussion.create", {
      topic,
      member_ids,
    });
  }

  readDiscussion(
    discussion_id: number,
    request: number | DiscussionReadRequest = {},
  ) {
    const params =
      typeof request === "number" ? { message_id: request } : request;
    const { action: _action, discussion_id: _discussionId, ...page } = params;
    return this.call<DiscussionReadResult>("discussion.read", {
      ...page,
      discussion_id,
    });
  }

  discussionPage(discussion_id: number, page: PageRequest) {
    return this.call<DiscussionPage>("discussion.page", {
      discussion_id,
      ...page,
    });
  }

  discussionPreviews(
    discussion_id: number,
    before?: [string, string],
    limit = 30,
  ) {
    return this.call<DiscussionPreviewPage>("discussion.previews", {
      discussion_id,
      before,
      limit,
    });
  }

  discussionPreview(discussion_id: number, preview_id: string) {
    return this.call<DiscussionPreviewRead>("discussion.preview", {
      discussion_id,
      preview_id,
    });
  }

  discussionPreviewText(
    discussion_id: number,
    preview_id: string,
    revision: number,
    offset: number,
  ) {
    return this.call<GenerationTextPage>("discussion.preview.text", {
      discussion_id,
      preview_id,
      revision,
      offset,
      limit: 16 * 1024,
    });
  }

  markRead(discussion_id: number, message_id: number) {
    return this.call<{ read_through: number }>("discussion.mark_read", {
      discussion_id,
      message_id,
    });
  }

  sendVisible(
    discussion_id: number,
    body: string,
    attachment_ids: string[] = [],
    client_message_id?: string,
  ) {
    return this.call<{ id: number }>("discussion.send", {
      discussion_id,
      body,
      attachment_ids,
      client_message_id,
      mark_read: false,
    });
  }

  sendStatus(discussion_id: number, client_message_id: string) {
    return this.call<{
      state: "sent" | "cancelled" | "unknown";
      message: Message | null;
    }>("discussion.send_status", { discussion_id, client_message_id });
  }

  cancelSend(discussion_id: number, client_message_id: string) {
    return this.call<{
      state: "sent" | "cancelled";
      message: Message | null;
    }>("discussion.cancel_send", { discussion_id, client_message_id });
  }

  createUpload(discussion_id: number, client_upload_id: string, file: File) {
    return this.call<UploadRecord>("upload.create", {
      discussion_id,
      client_upload_id,
      name: file.name,
      size: file.size,
      media_type: file.type,
    });
  }

  uploadStatus(upload_ids: string[]) {
    return this.call<UploadRecord[]>("upload.status", { upload_ids });
  }

  cancelUploads(upload_ids: string[]) {
    return this.call<{ cancelled: number }>("upload.cancel", { upload_ids });
  }

  async #fileConnection(path: string) {
    await this.#open();
    if (!this.#connectionUrl) throw new Error("Connection address is missing");
    const url = new URL(this.#connectionUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = path;
    url.search = "";
    return url.toString();
  }

  async uploadFile(
    id: string,
    file: File,
    signal: AbortSignal,
    progress: (sent: number) => void,
  ) {
    const url = await this.#fileConnection(
      `/uploads/${encodeURIComponent(id)}/content`,
    );
    signal.throwIfAborted();
    return new Promise<Attachment>((resolve, reject) => {
      const request = new XMLHttpRequest();
      const abort = () => request.abort();
      const finish = () => signal.removeEventListener("abort", abort);
      request.open("PUT", url);
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.timeout = 125_000;
      request.responseType = "json";
      request.upload.onprogress = (event) => progress(event.loaded);
      request.onload = () => {
        finish();
        if (request.status >= 200 && request.status < 300)
          resolve(request.response as Attachment);
        else
          reject(
            new BackendError(
              request.response?.error?.code ?? "upload_failed",
              request.response?.error?.message ??
                `Upload failed (${request.status})`,
            ),
          );
      };
      request.onerror = () => {
        finish();
        reject(new Error("Upload interrupted. Your message is preserved."));
      };
      request.ontimeout = () => {
        finish();
        reject(new Error("Upload timed out. Your message is preserved."));
      };
      request.onabort = () => {
        finish();
        reject(new DOMException("Upload cancelled", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      request.send(file);
    });
  }

  async attachmentFile(
    discussion: number,
    message: number,
    attachment: Attachment,
    signal: AbortSignal,
  ) {
    const url = await this.#fileConnection(
      `/discussions/${discussion}/messages/${message}/attachments/${encodeURIComponent(attachment.id)}/content`,
    );
    const response = await fetch(url, {
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const error = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : null;
      throw new BackendError(
        error?.error?.code ?? "download_failed",
        error?.error?.message ??
          `Could not read attachment (${response.status})`,
      );
    }
    if (response.headers.get("content-length") !== String(attachment.size))
      throw new Error("Attachment size does not match");
    const blob = await response.blob();
    if (blob.size !== attachment.size)
      throw new Error("Attachment download is incomplete");
    return blob;
  }

  async libraryFile(path: string, signal: AbortSignal) {
    const url = new URL(await this.#fileConnection("/library/content"));
    url.searchParams.set("path", path);
    const response = await fetch(url, {
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const error = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : null;
      throw new BackendError(
        error?.error?.code ?? "download_failed",
        error?.error?.message ?? `Could not read file (${response.status})`,
      );
    }
    return await response.blob();
  }

  send(discussion_id: number, body: string) {
    return this.call<{ id: number }>("discussion.send", {
      discussion_id,
      body,
    });
  }

  setDiscussionMembers(discussion_id: number, member_ids: number[]) {
    return this.call<DiscussionSummary>("discussion.set_members", {
      discussion_id,
      member_ids,
    });
  }

  archiveDiscussion(discussion_id: number, archived: boolean) {
    return this.call<{ id: number }>("discussion.archive", {
      discussion_id,
      archived,
    });
  }

  searchMessages(query: string) {
    return this.call<FoundMessage[]>("discussion.search", { query });
  }

  usageAdvance(initialization_version?: number): Promise<UsageIndexState> {
    const generation = this.#generation;
    if (
      this.#usageIndex?.generation === generation &&
      this.#usageIndex.value.ready &&
      (initialization_version === undefined ||
        this.#usageIndex.value.version === initialization_version)
    )
      return Promise.resolve(this.#usageIndex.value);
    const advancing = this.#usageAdvancing.get(initialization_version);
    if (advancing?.generation === generation) return advancing.operation;
    const operation = this.call<UsageIndexState>(
      "usage.advance",
      initialization_version === undefined ? {} : { initialization_version },
    )
      .then((value) => {
        if (generation === this.#generation)
          this.#usageIndex = { generation, value };
        return value;
      })
      .finally(() => {
        if (
          this.#usageAdvancing.get(initialization_version)?.operation ===
          operation
        )
          this.#usageAdvancing.delete(initialization_version);
      });
    this.#usageAdvancing.set(initialization_version, { generation, operation });
    return operation;
  }

  usageQuery(params: UsageQuery) {
    return this.call<UsageQueryResult>("usage.query", params);
  }

  usageRead(record_id: string) {
    return this.call<UsageDetail>("usage.read", { record_id });
  }

  agentLive(
    agent_id: number,
    sequence: number,
    ordinal: number,
    tool_after?: number,
    tool_limit?: number,
  ) {
    return this.call<LivePage>("agent.live", {
      agent_id,
      sequence,
      ordinal,
      tool_after,
      tool_limit,
    });
  }

  agentLiveRead(
    agent_id: number,
    sequence: number,
    ordinal: number,
    part_index: number,
    runtime_epoch: string,
    content_source?: "tool" | "response",
    content_version?: string | null,
  ) {
    return this.call<HistoryMessages>("agent.live.read", {
      agent_id,
      sequence,
      ordinal,
      part_index,
      runtime_epoch,
      content_source,
      content_version,
    });
  }

  agentHistoryWindows(agent_id: number, before?: number, limit = 30) {
    return this.call<AgentHistoryWindows>("agent.history.windows", {
      agent_id,
      before,
      limit,
    });
  }

  agentHistory(
    agent_id: number,
    before?: number,
    limit = 30,
    windows_after?: number,
    windows_limit = 30,
    options?: { window_number: number | null },
  ) {
    return this.call<AgentHistoryPage>("agent.history", {
      agent_id,
      before,
      limit,
      windows_after,
      windows_limit,
      ...options,
    });
  }

  agentHistoryRead(
    agent_id: number,
    sequence: number,
    ordinal?: number,
    message_offset = 0,
    input_offset = 0,
    response_offset = 0,
    related_offset = 0,
    options: {
      requestAfter?: number;
      windowsAfter?: number;
      parametersOffset?: number;
      settingsOffset?: number;
      modelOffset?: number;
    } = {},
  ) {
    return this.call<AgentHistoryRead>("agent.history.read", {
      agent_id,
      sequence,
      ordinal,
      message_offset,
      message_limit: 100,
      input_offset,
      input_limit: 100,
      response_offset,
      response_limit: 100,
      related_offset,
      related_limit: 100,
      request_after: options.requestAfter,
      request_limit: 30,
      windows_after: options.windowsAfter,
      windows_limit: 30,
      parameters_offset: options.parametersOffset,
      settings_offset: options.settingsOffset,
      model_offset: options.modelOffset,
      field_limit: 16 * 1024,
    });
  }

  agentHistoryText(
    agent_id: number,
    sequence: number,
    text: Pick<HistoryText, "source" | "message_index" | "path"> & {
      request_ordinal?: number;
      part_index?: number;
      runtime_epoch?: string;
      content_source?: "tool" | "response";
      content_version?: string | null;
      offset: number;
    },
  ) {
    return this.call<
      Omit<HistoryText, "kind" | "source" | "message_index" | "path">
    >("agent.history.text", {
      agent_id,
      sequence,
      source: text.source,
      ordinal: text.request_ordinal,
      part_index: text.part_index,
      runtime_epoch: text.runtime_epoch,
      content_source: text.content_source,
      content_version: text.content_version,
      message_index: text.message_index,
      path: text.path,
      offset: text.offset,
      limit: 16 * 1024,
    });
  }

  agentGenerationParts(
    agent_id: number,
    sequence: number,
    ordinal: number,
    after?: number,
    limit = 30,
  ) {
    return this.call<GenerationPartPage>("agent.generation.parts", {
      agent_id,
      sequence,
      ordinal,
      after,
      limit,
    });
  }

  agentGenerationText(
    key: GenerationKey,
    revision: number,
    field: GenerationField,
    offset = 0,
  ) {
    return this.call<GenerationPartText>("agent.generation.text", {
      agent_id: key.agent_id,
      sequence: key.sequence,
      ordinal: key.ordinal,
      part_index: key.part_index,
      request_id: key.request_id,
      revision,
      field,
      offset,
      limit: 16 * 1024,
    });
  }

  agentHistoryImage(
    agent_id: number,
    sequence: number,
    image: Pick<HistoryBinary, "source" | "message_index" | "path"> & {
      request_ordinal?: number;
      part_index?: number;
      runtime_epoch?: string;
      content_source?: "tool" | "response";
      content_version?: string | null;
    },
  ) {
    return this.call<HistoryImage>("agent.history.image", {
      agent_id,
      sequence,
      source: image.source,
      ordinal: image.request_ordinal,
      part_index: image.part_index,
      runtime_epoch: image.runtime_epoch,
      content_source: image.content_source,
      content_version: image.content_version,
      message_index: image.message_index,
      path: image.path,
    });
  }

  library(path?: string) {
    return this.call<LibraryEntry[]>("library.list", { path });
  }

  mkdirLibrary(path: string) {
    return this.call<LibraryEntry>("library.mkdir", { path });
  }

  workspaceList(agent_id: number, path?: string) {
    return this.call<LibraryEntry[]>("workspace.list", { agent_id, path });
  }

  workspaceRead(agent_id: number, path: string) {
    return this.call<LibraryDocument>("workspace.read", { agent_id, path });
  }

  readLibrary(path: string) {
    return this.call<LibraryDocument>("library.read", { path });
  }

  writeLibrary(path: string, content: string, expected_hash?: string) {
    return this.call<LibraryWriteResult>("library.write", {
      path,
      content,
      expected_hash,
    });
  }

  deleteLibrary(path: string) {
    return this.call<{ path: string }>("library.delete", { path });
  }

  moveLibrary(path: string, destination: string) {
    return this.call<LibraryEntry>("library.move", { path, destination });
  }

  settings(section: string) {
    return this.call<Record<string, unknown>>("settings.get", { section });
  }

  updateSettings(section: string, values: Record<string, unknown>) {
    return this.call<Record<string, unknown>>("settings.update", {
      section,
      values,
    });
  }
}

export const backend = new Backend();
