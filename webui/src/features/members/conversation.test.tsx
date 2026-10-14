import * as testing from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationProvider } from "@/app/organization";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as activityData from "@/features/members/activity-data";
import { ConversationFeed } from "@/features/members/conversation";
import { ConversationHistory } from "@/features/members/conversation-history";
import { TestWorkflow } from "@/features/members/conversation-test-workflow";
import {
  type WindowCache,
  WindowContext,
} from "@/features/members/window-cache";
import {
  type AgentHistoryPage,
  type AgentHistoryRead,
  type AgentHistoryRun,
  type AgentHistoryWindows,
  type AgentRun,
  BackendError,
  type BackendEvent,
  backend,
  type HistoryText,
  type HistoryValue,
  type LivePage,
  type Message,
} from "@/lib/backend";

const listeners = new Set<(event: BackendEvent) => void>();
const observers = new Map<Element, Set<TestResizeObserver>>();
const workflows = new Set<TestWorkflow>();

function workflow<Args extends unknown[]>(
  work: (scope: TestWorkflow, ...args: Args) => Promise<void>,
) {
  return (...args: Args) => {
    const scope = new TestWorkflow();
    workflows.add(scope);
    return scope.run(() => work(scope, ...args));
  };
}

function test(name: string, work: (scope: TestWorkflow) => Promise<void>) {
  it(name, workflow(work));
}

function complete(scope: TestWorkflow, work: () => void | Promise<void>) {
  return scope.step(() => testing.act(work));
}

function ownedHistoryPage(scope: TestWorkflow, value: AgentHistoryPage) {
  const pending = deferred<AgentHistoryPage>();
  scope.own(() => pending.resolve(value));
  return pending;
}

class TestResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target);
    const registered = observers.get(target) ?? new Set<TestResizeObserver>();
    registered.add(this);
    observers.set(target, registered);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
    const registered = observers.get(target);
    if (!registered) return;
    registered.delete(this);
    if (!registered.size) observers.delete(target);
  }
  disconnect() {
    for (const target of this.targets) this.unobserve(target);
  }
}

function resizeTarget(target: Element) {
  for (const observer of [...(observers.get(target) ?? [])]) {
    if (!observer.targets.has(target)) continue;
    observer.callback(
      [{ target } as ResizeObserverEntry],
      observer as unknown as ResizeObserver,
    );
  }
}

vi.stubGlobal("ResizeObserver", TestResizeObserver);
afterEach(async () => {
  try {
    for (const scope of workflows) scope.stop();
    testing.cleanup();
    for (const scope of workflows) scope.release();
    await Promise.all([...workflows].map((scope) => scope.wait()));
    if (workflows.size) await testing.act(async () => {});
    expect(listeners.size).toBe(0);
    expect(observers.size).toBe(0);
    expect(document.body.childElementCount).toBe(0);
  } finally {
    workflows.clear();
    listeners.clear();
    observers.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

const date = "2026-10-08T09:15:00Z";
function run(sequence = 4, windowNumber: number | null = 1): AgentHistoryRun {
  return {
    sequence,
    run_id: `run-${sequence}`,
    status: "completed",
    started_at: date,
    completed_at: date,
    last_saved_at: date,
    window_number: windowNumber,
    window_reset_at: null,
    window_reason: null,
    request_count: 1,
    usage: null,
    error: null,
    legacy: false,
    reminded: [],
  };
}
function directory(
  numbers = [1],
  current = numbers[0],
  more = false,
): AgentHistoryWindows {
  return {
    agent_id: 2,
    current_window_number: current,
    has_unassigned: false,
    windows: numbers.map((number) => ({
      number,
      since_sequence: number,
      started_at: date,
      start_reason: number === 1 ? null : "prepared",
      ended_at: number === current ? null : date,
      end_reason: number === current ? null : "overflow",
      is_current: number === current,
    })),
    has_before: more,
    next_before: more ? Math.min(...numbers) : null,
  };
}
function page(
  windowNumber: number | null,
  sequences: number[],
  more = false,
): AgentHistoryPage {
  return {
    agent_id: 2,
    window_number: windowNumber,
    runs: sequences.map((sequence) => run(sequence, windowNumber)),
    windows: [],
    has_before: more,
    next_before: more ? Math.min(...sequences) : null,
    windows_has_more: false,
    windows_next_after: null,
  };
}
const empty = { offset: 0, total: 0, messages: [], has_more: false };
function read(
  sequence: number,
  parts: HistoryValue[],
  results: HistoryValue[] = [],
): AgentHistoryRead {
  const summary = {
    ordinal: 1,
    request_id: "request",
    run_id: `run-${sequence}`,
    window_number: 1,
    status: "completed",
    started_at: date,
    completed_at: date,
    streaming: false,
    input_length: 0,
    parameters_length: 2,
    settings_length: 2,
    model_length: 2,
    response_length: 100,
    input_count: 0,
    response_count: 1,
    related_count: results.length ? 1 : 0,
    error: null,
  };
  const field: HistoryText = {
    kind: "text",
    source: "parameters",
    request_ordinal: 1,
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
    run: run(sequence),
    windows: [],
    windows_has_more: false,
    windows_next_after: null,
    requests: [summary],
    requests_has_more: false,
    requests_next_after: null,
    messages: empty,
    missing: [],
    request: {
      summary,
      input: empty,
      parameters: field,
      settings: { ...field, source: "settings" },
      model: { ...field, source: "model" },
      response: {
        ...empty,
        total: 1,
        messages: [{ kind: "response", timestamp: date, parts }],
      },
      related: {
        ...empty,
        total: results.length ? 1 : 0,
        messages: results.length ? [{ kind: "request", parts: results }] : [],
      },
    },
  };
}
function command(
  content: HistoryValue,
  args: HistoryValue = { argv: ["cat", "/project/fora/docs/发布说明.md"] },
) {
  return read(
    4,
    [{ part_kind: "tool-call", tool_name: "run", tool_call_id: "read", args }],
    [
      {
        part_kind: "tool-return",
        tool_name: "run",
        tool_call_id: "read",
        content,
      },
    ],
  );
}
function message(id: number, senderId = 1, body = "请查看发布说明"): Message {
  return {
    id,
    sender_id: senderId,
    sender_name: senderId === 1 ? "林小雨" : "文档助手",
    body,
    created_at: "2026-10-07T18:00:00Z",
    mentions: [],
    attachments: [],
  } as Message;
}
function discussionRead(saved: Message): AgentHistoryRead {
  return read(
    4,
    [
      {
        part_kind: "tool-call",
        tool_name: "discussion",
        tool_call_id: "messages",
        args: { action: "read", discussion_id: 8 },
      },
    ],
    [
      {
        part_kind: "tool-return",
        tool_name: "discussion",
        tool_call_id: "messages",
        content: { id: 8, messages: [saved as unknown as HistoryValue] },
      },
    ],
  );
}
function withReminder(
  value: AgentHistoryRead,
  content: string,
): AgentHistoryRead {
  if (!value.request) throw new Error("Saved request is missing");
  value.run.reminded = [{ discussion_id: 8, message_id: 12 }];
  value.request.input = {
    ...empty,
    total: 1,
    messages: [
      {
        kind: "request",
        run_id: null,
        timestamp: date,
        metadata: {
          fora: {
            context_sources: {
              version: 1,
              metadata_was_none: true,
              fora_was_missing: true,
              parts: [
                {
                  part_index: 0,
                  kind: "reminder",
                  source_id: `reminder-${value.run.sequence}`,
                  agent_id: 2,
                  sequence: value.run.sequence,
                },
              ],
            },
          },
        },
        parts: [{ part_kind: "user-prompt", content, timestamp: date }],
      },
    ],
  };
  value.request.response = value.request.response
    ? {
        ...value.request.response,
        messages: value.request.response.messages.map((message) => ({
          ...(message as Record<string, HistoryValue>),
          run_id: "sdk-current",
        })),
      }
    : null;
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function view(
  runs: AgentRun[] = [],
  scroll = false,
  controls = false,
  feed?: ReactNode,
  name = "文档助手",
) {
  return (
    <TooltipProvider>
      <OrganizationProvider
        value={{
          members: [{ id: 2, name, type: "agent", state: "idle" }],
          humanId: 1,
          discussions: [],
          connectionError: null,
          organizationError: null,
          discussionsError: null,
          retry: async () => {},
          refresh: async () => {},
        }}
      >
        {controls ? <input aria-label="Before history" /> : null}
        <div
          className={scroll ? "conversation-scroll" : ""}
          style={{ overflowY: scroll ? "auto" : "visible" }}
          data-testid="scroll"
        >
          {feed ?? <ConversationHistory agentId={2} initialRuns={runs} />}
        </div>
        {controls ? <input aria-label="After history" /> : null}
      </OrganizationProvider>
    </TooltipProvider>
  );
}
function mount(scroll = false, controls = false) {
  return testing.render(view([], scroll, controls));
}
async function chooseWindow(trigger: HTMLElement, key: string) {
  testing.fireEvent.click(trigger);
  const list = await testing.screen.findByRole("listbox", {
    name: "Context windows",
  });
  const option = testing
    .within(list)
    .getAllByRole("option")
    .find((item) => item.getAttribute("data-value") === key);
  if (!option) throw new Error(`Window ${key} is unavailable`);
  testing.fireEvent.click(option);
  await testing.waitFor(() =>
    expect(
      testing.screen.queryByRole("listbox", { name: "Context windows" }),
    ).toBeNull(),
  );
}
async function event(value: BackendEvent) {
  await testing.act(async () => {
    for (const listener of listeners) listener(value);
  });
}
beforeEach(() => {
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(false);
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  vi.spyOn(backend, "agentHistoryWindows").mockResolvedValue(directory());
  vi.spyOn(backend, "agentHistory").mockResolvedValue(page(1, [4]));
  vi.spyOn(backend, "agentHistoryRead").mockResolvedValue(
    read(4, [{ part_kind: "text", content: "发布说明已完成 **校验**。" }]),
  );
});

function liveToolPage(
  partIndex: number,
  status: "running" | "completed",
  revision: number,
  saved = false,
): LivePage {
  return {
    runtime_epoch: "live-epoch",
    turn: {
      agent_id: 2,
      sequence: 4,
      run_id: "run-4",
      live_revision: revision,
      status: "running",
      error: null,
      has_more: false,
      next_after: null,
      requests: [
        {
          ordinal: 1,
          request_id: "request",
          started_at: date,
          tools_has_more: false,
          tools_next_after: null,
          tools: [
            {
              part_index: partIndex,
              tool_call_id: partIndex === 0 ? "short" : "long",
              tool_name: "run",
              status,
              started_at: date,
              completed_at: status === "completed" ? date : null,
              saved,
              has_result: status === "completed" && !saved,
              content_version: `${partIndex}:${status}`,
            },
          ],
        },
      ],
    },
  };
}

function runningTools(): AgentHistoryRead {
  const value = read(4, [
    {
      part_kind: "tool-call",
      tool_name: "run",
      tool_call_id: "short",
      args: { argv: ["short"] },
    },
    {
      part_kind: "tool-call",
      tool_name: "run",
      tool_call_id: "long",
      args: { argv: ["long"] },
    },
  ]);
  value.run.status = "running";
  value.run.completed_at = null;
  if (!value.request) throw new Error("Request is missing");
  value.request.observation = {
    runtime_epoch: "live-epoch",
    live_revision: 1,
    request_id: "request",
  };
  return value;
}

describe("Member conversation", () => {
  test("reads a growing part independently and preserves its unit when the response is saved", async (scope) => {
    const pending = read(4, []);
    if (!pending.request) throw new Error("Saved request is missing");
    pending.run.status = "running";
    pending.request.summary.status = "pending";
    pending.request.response = null;
    const key = {
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      part_index: 0,
      request_id: pending.request.summary.request_id,
      run_id: pending.request.summary.run_id,
    };
    let revision = 1;
    const source = () =>
      revision === 1
        ? "## 当前内容\n\n已经收到 **正文**。"
        : "## 当前内容\n\n已经收到 **完整正文**。";
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(pending);
    vi.spyOn(backend, "agentGenerationParts").mockImplementation(async () => ({
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      parts: [
        {
          key,
          revision,
          part_kind: "text",
          status: "generating",
          error: null,
          created_at: date,
          updated_at: date,
          tool_name: null,
          tool_call_id: null,
        },
      ],
      has_more: false,
      next_after: null,
    }));
    vi.spyOn(backend, "agentGenerationText").mockImplementation(
      async (_key, currentRevision, field, offset = 0) => {
        const value = source();
        const bytes = new TextEncoder().encode(value).length;
        return {
          key,
          field,
          revision: currentRevision,
          value,
          offset,
          next_offset: bytes,
          total_bytes: bytes,
          has_more: false,
        };
      },
    );
    await complete(scope, async () => {
      mount();
    });
    const heading = testing.screen.getByRole("heading", {
      name: "当前内容",
    });
    const unit = heading.closest("article");
    expect(
      testing.screen.getByText("正文", {
        selector: "[data-streamdown='strong']",
      }),
    ).toBeTruthy();
    const reads = vi.mocked(backend.agentHistoryRead).mock.calls.length;
    revision = 2;
    await scope.step(() =>
      event({ type: "turn.generation", ...key, revision } as BackendEvent),
    );
    expect(
      testing.screen.getByText("完整正文", {
        selector: "[data-streamdown='strong']",
      }),
    ).toBeTruthy();
    expect(vi.mocked(backend.agentHistoryRead).mock.calls.length).toBe(reads);
    expect(
      testing.screen
        .getByRole("heading", { name: "当前内容" })
        .closest("article"),
    ).toBe(unit);
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(4, [{ part_kind: "text", content: source() }]),
    );
    await scope.step(() =>
      event({
        type: "turn.finished",
        agent_id: 2,
        sequence: 4,
      } as BackendEvent),
    );
    expect(
      testing.screen.queryByRole("status", { name: "Generating" }),
    ).toBeNull();
    expect(
      testing.screen.getAllByRole("heading", { name: "当前内容" }),
    ).toHaveLength(1);
    expect(
      testing.screen
        .getByRole("heading", { name: "当前内容" })
        .closest("article"),
    ).toBe(unit);
  });

  test("renders saved send text and copies its original Markdown", async (scope) => {
    const body =
      "# 更新\n\n@文档助手 **正文**\n\n![图片](https://example.com/image.png)\n\n<script>unsafe</script>";
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(
        4,
        [
          {
            part_kind: "tool-call",
            tool_name: "discussion",
            tool_call_id: "saved-send",
            args: { action: "send", discussion_id: 8, body },
          },
        ],
        [
          {
            part_kind: "tool-return",
            tool_name: "discussion",
            tool_call_id: "saved-send",
            content: { discussion_id: 8, id: 12, created_at: date },
          },
        ],
      ),
    );
    const current = vi.spyOn(backend, "discussionPage");
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboard },
    });
    await complete(scope, async () => {
      mount();
    });
    const heading = testing.screen.getByRole("heading", {
      name: "更新",
    });
    const article = heading.closest("article");
    expect(article?.querySelector("mark")).toBeNull();
    expect(current).not.toHaveBeenCalled();
    expect(article?.querySelector("img")).toBeNull();
    expect(
      testing.screen.getByRole("link", { name: "图片" }).getAttribute("href"),
    ).toBe("https://example.com/image.png");
    expect(article?.querySelector("script")).toBeNull();
    expect(article?.textContent).toContain("<script>unsafe</script>");
    await complete(scope, async () => {
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Copy message text" }),
      );
    });
    expect(clipboard).toHaveBeenCalledWith(body);
    expect(
      testing.screen
        .getByRole("button", { name: "Copied" })
        .closest(".message-copy")
        ?.parentElement?.querySelector("time"),
    ).not.toBeNull();
  });

  test("renders and copies TextPart and ThinkingPart with independent saved identities", async (scope) => {
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(4, [
        { part_kind: "thinking", content: "## 思考\n\n分析 **依据**。" },
        { part_kind: "text", content: "## 回应\n\n完成 **检查**。" },
      ]),
    );
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboard },
    });
    await complete(scope, async () => {
      mount();
    });
    const response = testing.screen.getByRole("heading", {
      name: "回应",
    });
    const thinking = testing.screen.getByText("思考");
    expect(thinking.closest("details")?.open).toBe(false);
    expect(
      thinking.closest(".markdown-content")?.getAttribute("data-content-id"),
    ).not.toBe(
      response.closest(".markdown-content")?.getAttribute("data-content-id"),
    );
    const copy = response
      .closest("article")
      ?.querySelector<HTMLButtonElement>(
        "button[aria-label='Copy message text']",
      );
    if (!copy) throw new Error("Copy button is unavailable");
    await complete(scope, async () => {
      testing.fireEvent.click(copy);
    });
    expect(clipboard).toHaveBeenCalledWith("## 回应\n\n完成 **检查**。");
  });

  test("shows complete generated parameters through the existing field presentation", async (scope) => {
    const pending = read(4, []);
    if (!pending.request) throw new Error("Saved request is missing");
    pending.request.response = null;
    pending.request.summary.status = "pending";
    const key = {
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      part_index: 0,
      request_id: pending.request.summary.request_id,
      run_id: pending.request.summary.run_id,
    };
    let revision = 1;
    let args = '{"argv":["cat","资料';
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(pending);
    vi.spyOn(backend, "agentGenerationParts").mockImplementation(async () => ({
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      has_more: false,
      next_after: null,
      parts: [
        {
          key,
          revision,
          part_kind: "tool-call",
          status: "generating",
          error: null,
          tool_name: "run",
          tool_call_id: "generated-run",
          created_at: date,
          updated_at: date,
        },
      ],
    }));
    const text = vi
      .spyOn(backend, "agentGenerationText")
      .mockImplementation(async (_key, currentRevision, field, offset = 0) => ({
        key,
        field,
        revision: currentRevision,
        value: args,
        offset,
        next_offset: new TextEncoder().encode(args).length,
        total_bytes: new TextEncoder().encode(args).length,
        has_more: false,
      }));
    await complete(scope, async () => {
      mount();
    });
    const toggle = testing.screen.getByRole("button", {
      name: /Run command/,
    });
    expect(text).not.toHaveBeenCalled();
    await complete(scope, async () => {
      testing.fireEvent.click(toggle);
    });
    expect(testing.screen.getByText(args)).toBeTruthy();
    args = JSON.stringify({ argv: ["cat", "资料.md"], cwd: "/project/fora" });
    revision = 2;
    await scope.step(() =>
      event({ type: "turn.generation", ...key, revision } as BackendEvent),
    );
    expect(testing.screen.getByText("argv 1")).toBeTruthy();
    expect(testing.screen.getByText("资料.md")).toBeTruthy();
    expect(testing.screen.getByText("cwd")).toBeTruthy();
    expect(testing.screen.queryByText(args)).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(text.mock.calls.every((call) => call[2] === "args")).toBe(true);
  });

  test("keeps failed generation readable and opens its request from the information line", async (scope) => {
    const pending = read(4, []);
    if (!pending.request) throw new Error("Saved request is missing");
    pending.request.response = null;
    const key = {
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      part_index: 0,
      request_id: pending.request.summary.request_id,
      run_id: pending.request.summary.run_id,
    };
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(pending);
    vi.spyOn(backend, "agentGenerationParts").mockResolvedValue({
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      has_more: false,
      next_after: null,
      parts: [
        {
          key,
          revision: 2,
          part_kind: "text",
          status: "failed",
          error: "Provider timed out",
          tool_name: null,
          tool_call_id: null,
          created_at: date,
          updated_at: date,
        },
      ],
    });
    const body = "## 保存的正文\n\n收到 **最后内容**。";
    const bytes = new TextEncoder().encode(body).length;
    vi.spyOn(backend, "agentGenerationText").mockResolvedValue({
      key,
      field: "content",
      revision: 2,
      value: body,
      offset: 0,
      next_offset: bytes,
      total_bytes: bytes,
      has_more: false,
    });
    await complete(scope, async () => {
      mount();
    });
    const heading = testing.screen.getByRole("heading", {
      name: "保存的正文",
    });
    const icon = testing.screen.getByRole("button", {
      name: "Not sent: Provider timed out",
    });
    expect(icon.closest("article")).toBe(heading.closest("article"));
    expect(icon.parentElement?.querySelector("time")).not.toBeNull();
    expect(
      testing.screen.queryByRole("status", { name: "Generating" }),
    ).toBeNull();
    await complete(scope, async () => {
      testing.fireEvent.click(icon);
    });
    expect(testing.screen.getByRole("dialog")).toBeTruthy();
    expect(
      vi
        .mocked(backend.agentHistoryRead)
        .mock.calls.some(
          (call) => call[0] === 2 && call[1] === 4 && call[2] === 1,
        ),
    ).toBe(true);
  });

  test("preserves requested text pages and the 300px expansion state while generated revisions arrive", async (scope) => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
    const pending = read(4, []);
    if (!pending.request) throw new Error("Saved request is missing");
    pending.request.response = null;
    const key = {
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      part_index: 0,
      request_id: pending.request.summary.request_id,
      run_id: pending.request.summary.run_id,
    };
    let revision = 1;
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(pending);
    vi.spyOn(backend, "agentGenerationParts").mockImplementation(async () => ({
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      has_more: false,
      next_after: null,
      parts: [
        {
          key,
          revision,
          part_kind: "text",
          status: "generating",
          error: null,
          tool_name: null,
          tool_call_id: null,
          created_at: date,
          updated_at: date,
        },
      ],
    }));
    const text = vi
      .spyOn(backend, "agentGenerationText")
      .mockImplementation(async (_key, currentRevision, field, offset = 0) => {
        const chunks = [
          `生成正文 ${currentRevision}\n\n`,
          `第二页正文 ${currentRevision}\n\n`,
          `第三页正文 ${currentRevision}`,
        ];
        const sizes = chunks.map(
          (value) => new TextEncoder().encode(value).length,
        );
        const index = offset === 0 ? 0 : offset === sizes[0] ? 1 : 2;
        const total = sizes.reduce((sum, value) => sum + value, 0);
        return {
          key,
          field,
          revision: currentRevision,
          value: chunks[index],
          offset,
          next_offset: offset + sizes[index],
          total_bytes: total,
          has_more: offset + sizes[index] < total,
        };
      });
    await complete(scope, async () => {
      mount();
    });
    const body = testing.screen.getByText("生成正文 1");
    const article = body.closest("article");
    const toggle = testing.screen.getByRole("button", { name: "Show more" });
    expect(article?.querySelector(".max-h-\\[300px\\]")).not.toBeNull();
    await complete(scope, async () => {
      testing.fireEvent.click(toggle);
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Load more text" }),
      );
    });
    expect(testing.screen.getByText("第二页正文 1")).toBeTruthy();
    await complete(scope, async () => {
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Load more text" }),
      );
    });
    expect(testing.screen.getByText("第三页正文 1")).toBeTruthy();
    expect(
      testing.screen.queryByRole("button", { name: "Load more text" }),
    ).toBeNull();
    revision = 2;
    await scope.step(() =>
      event({ type: "turn.generation", ...key, revision } as BackendEvent),
    );
    expect(testing.screen.getByText("生成正文 2").closest("article")).toBe(
      article,
    );
    expect(testing.screen.getByText("第二页正文 2").closest("article")).toBe(
      article,
    );
    expect(testing.screen.getByText("第三页正文 2").closest("article")).toBe(
      article,
    );
    expect(
      text.mock.calls
        .filter((call) => call[1] === 2)
        .map((call) => call[3] ?? 0),
    ).toEqual([0, 16, 35]);
    expect(testing.screen.getByRole("button", { name: "Show less" })).toBe(
      toggle,
    );
    expect(article?.querySelector(".max-h-\\[300px\\]")).toBeNull();
  });

  it("observes multiple targets and independently releases shared targets", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    const one = vi.fn<ResizeObserverCallback>();
    const two = vi.fn<ResizeObserverCallback>();
    const observer = new ResizeObserver(one);
    const shared = new ResizeObserver(two);
    observer.observe(first);
    observer.observe(first);
    observer.observe(second);
    shared.observe(first);
    resizeTarget(first);
    expect(one).toHaveBeenCalledOnce();
    expect(two).toHaveBeenCalledOnce();
    expect(one.mock.calls[0][0][0].target).toBe(first);
    expect(one.mock.calls[0][1]).toBe(observer);
    observer.unobserve(first);
    resizeTarget(first);
    expect(one).toHaveBeenCalledOnce();
    expect(two).toHaveBeenCalledTimes(2);
    resizeTarget(second);
    expect(one).toHaveBeenCalledTimes(2);
    expect(one.mock.calls[1][0][0].target).toBe(second);
    observer.disconnect();
    resizeTarget(second);
    expect(one).toHaveBeenCalledTimes(2);
    shared.disconnect();
    resizeTarget(first);
    expect(two).toHaveBeenCalledTimes(2);
    expect(observers.size).toBe(0);
    observer.observe(second);
    resizeTarget(second);
    expect(one).toHaveBeenCalledTimes(3);
    observer.disconnect();
  });

  it(
    "publishes a short tool result while its parallel tool remains running",
    workflow(async (scope) => {
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(runningTools());
      let completed = false;
      vi.spyOn(backend, "agentLive").mockImplementation(
        async (_agent, _sequence, _ordinal, after, limit) => {
          expect(limit).toBe(1);
          const partIndex = after === undefined ? 0 : after + 1;
          return liveToolPage(
            partIndex,
            partIndex === 0 && completed ? "completed" : "running",
            completed ? 2 : 1,
          );
        },
      );
      vi.spyOn(backend, "agentLiveRead").mockResolvedValue({
        offset: 0,
        total: 1,
        has_more: false,
        saved: false,
        messages: [
          {
            kind: "request",
            parts: [
              {
                part_kind: "tool-return",
                tool_name: "run",
                tool_call_id: "short",
                outcome: "success",
                content: { stdout: "short result", exit_code: 0 },
              },
            ],
          },
        ],
      });
      await complete(scope, async () => {
        mount();
      });
      const feed = testing.within(
        testing.screen.getByRole("feed", { name: "Activity history" }),
      );
      const short = feed.getByRole("button", {
        name: "Run short · Running",
      });
      expect(
        feed.getByRole("button", { name: "Run long · Running" }),
      ).toBeTruthy();
      await complete(scope, async () => {
        testing.fireEvent.click(short);
      });
      expect(backend.agentLiveRead).not.toHaveBeenCalled();
      vi.useFakeTimers();
      completed = true;
      await scope.step(() =>
        event({
          type: "tool.updated",
          agent_id: 2,
          sequence: 4,
          ordinal: 1,
          part_index: 0,
        }),
      );
      await complete(scope, async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(
        feed.getByRole("button", { name: "Run short · Completed" }),
      ).toBeTruthy();
      expect(
        feed.getByRole("button", { name: "Run long · Running" }),
      ).toBeTruthy();
      expect(feed.getByText("short result")).toBeTruthy();
      expect(feed.getByText("Not saved")).toBeTruthy();
      expect(backend.agentLiveRead).toHaveBeenCalledWith(
        2,
        4,
        1,
        0,
        "live-epoch",
        "tool",
        "0:completed",
      );
    }),
  );

  it.each([
    ["queued", "Queued", null],
    ["running", "Running", date],
    ["failed", "Failed", null],
    ["cancelled", "Cancelled", date],
  ] as const)(
    "shows the observed %s state with its actual start time",
    workflow<
      ["queued" | "running" | "failed" | "cancelled", string, string | null]
    >(async (scope, status, label, started) => {
      const value = read(4, [
        {
          part_kind: "tool-call",
          tool_name: "run",
          tool_call_id: "short",
          args: { argv: ["short"] },
        },
      ]);
      value.run.status = "running";
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
      vi.spyOn(backend, "agentLive").mockImplementation(async () => {
        const page = liveToolPage(0, "running", 1);
        if (!page.turn) throw new Error("Turn is missing");
        const tool = page.turn.requests[0].tools[0];
        tool.status = status;
        tool.started_at = started;
        tool.completed_at =
          status === "failed" || status === "cancelled" ? date : null;
        return page;
      });
      const result = vi.spyOn(backend, "agentLiveRead");
      await complete(scope, async () => {
        mount();
      });
      const feed = testing.within(
        testing.screen.getByRole("feed", { name: "Activity history" }),
      );
      const action = feed.getByRole("button", {
        name: `Run short · ${label}`,
      });
      await complete(scope, async () => {
        testing.fireEvent.click(action);
      });
      expect(testing.screen.queryByText("Not saved")).toBeNull();
      expect(testing.screen.queryByText(/^Started /) !== null).toBe(
        started !== null,
      );
      expect(result).not.toHaveBeenCalled();
    }),
  );

  it("reads saved SDK image positions together with their tool lifecycle", async () => {
    const binary = {
      kind: "binary",
      source: "related",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 1, "content", 0],
      media_type: "image/png",
      size: 3,
      identifier: null,
    };
    const value = command("Image ready");
    if (!value.request) throw new Error("Request is missing");
    value.request.related.messages = [
      {
        kind: "request",
        metadata: {
          fora: {
            request_id: "request",
            request_ordinal: 1,
            tool_observations: [
              {
                request_ordinal: 1,
                part_index: 0,
                tool_call_id: "read",
                tool_name: "run",
                status: "completed",
                started_at: date,
                completed_at: date,
                has_result: true,
                content_version: "saved-image",
                result_positions: [
                  [0, 0],
                  [0, 1],
                ],
              },
            ],
          },
        },
        parts: [
          {
            part_kind: "tool-return",
            tool_call_id: "read",
            tool_name: "run",
            outcome: "success",
            content: "Image ready",
          },
          { part_kind: "user-prompt", content: [binary] },
        ],
      },
    ];
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    const image = vi.spyOn(backend, "agentHistoryImage").mockResolvedValue({
      media_type: "image/png",
      data: "bmV3",
      size: 3,
      identifier: null,
    });
    mount();
    testing.fireEvent.click(
      await testing.screen.findByRole("button", {
        name: "Read file docs/发布说明.md · Completed",
      }),
    );
    await testing.screen.findByRole("button", { name: "Open history image" });
    expect(image).toHaveBeenCalledWith(2, 4, binary);
    expect(testing.screen.getByText(/^Started /)).toBeTruthy();
    expect(testing.screen.getByText(/^Finished /)).toBeTruthy();
    expect(testing.screen.getByText("Image ready")).toBeTruthy();
    expect(testing.screen.queryByText("Not saved")).toBeNull();
  });

  it("uses the saved SDK outcome independently of command output fields", async () => {
    const value = command({ exit_code: 1, stderr: "Command output" });
    if (!value.request) throw new Error("Request is missing");
    const message = value.request.related.messages[0];
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      !Array.isArray(message.parts)
    )
      throw new Error("Saved result is missing");
    const part = message.parts[0];
    if (typeof part !== "object" || part === null || Array.isArray(part))
      throw new Error("Saved part is missing");
    part.outcome = "success";
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    mount();
    const action = await testing.screen.findByRole("button", {
      name: "Read file docs/发布说明.md · Completed",
    });
    testing.fireEvent.click(action);
    expect(await testing.screen.findByText("exit_code")).toBeTruthy();
    expect(testing.screen.getByText("1")).toBeTruthy();
    expect(testing.screen.getByText("Command output")).toBeTruthy();
  });

  it("batches fast activity reads during continuous notifications and cleans its timers", async () => {
    mount();
    await testing.screen.findByText(/发布说明已完成/);
    vi.useFakeTimers();
    const before = vi.mocked(backend.agentHistoryRead).mock.calls.length;
    for (let index = 1; index <= 20; index += 1) {
      await event({
        type: "tool.updated",
        agent_id: 2,
        sequence: 4,
        ordinal: 1,
      });
      await testing.act(async () => vi.advanceTimersByTimeAsync(50));
      expect(backend.agentHistoryRead).toHaveBeenCalledTimes(
        before + Math.floor((index * 50) / 150),
      );
    }
    await event({ type: "turn.finished", agent_id: 2, sequence: 4 });
    expect(backend.agentHistoryRead).toHaveBeenCalledTimes(before + 7);
    await event({ type: "tool.updated", agent_id: 2, sequence: 4 });
    testing.cleanup();
    await testing.act(async () => vi.advanceTimersByTimeAsync(200));
    expect(backend.agentHistoryRead).toHaveBeenCalledTimes(before + 7);
    expect(listeners.size).toBe(0);
  });

  it("publishes throughout ten seconds of notifications with one delayed activity read", async () => {
    mount();
    await testing.screen.findByText(/发布说明已完成/);
    vi.useFakeTimers();
    let received = 0;
    let completed = 0;
    let inFlight = 0;
    let maximum = 0;
    const before = vi.mocked(backend.agentHistoryRead).mock.calls.length;
    vi.mocked(backend.agentHistoryRead).mockImplementation(async () => {
      const value = received;
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 300));
      inFlight -= 1;
      completed = value;
      return read(4, [{ part_kind: "text", content: `Received ${value}` }]);
    });
    for (let index = 1; index <= 200; index += 1) {
      received = index;
      await event({ type: "tool.updated", agent_id: 2, sequence: 4 });
      await testing.act(async () => vi.advanceTimersByTimeAsync(50));
      if (index % 20 === 0) {
        expect(completed).toBeGreaterThanOrEqual(index - 12);
        expect(testing.screen.getByText(`Received ${completed}`)).toBeTruthy();
      }
    }
    await event({ type: "turn.finished", agent_id: 2, sequence: 4 });
    await testing.act(async () => vi.advanceTimersByTimeAsync(650));
    expect(testing.screen.getByText("Received 200")).toBeTruthy();
    expect(maximum).toBe(1);
    expect(inFlight).toBe(0);
    expect(
      vi.mocked(backend.agentHistoryRead).mock.calls.length - before,
    ).toBeLessThanOrEqual(35);
    testing.cleanup();
    expect(listeners.size).toBe(0);
  });

  it("binds text continuations to the current temporary version and switches to saved content", async () => {
    let version = "v1";
    let saved = false;
    const reference = (): HistoryText => ({
      kind: "text",
      source: saved ? "response" : "live",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 0, "content"],
      offset: 0,
      next_offset: 2,
      total_bytes: 4,
      value: version,
      has_more: true,
      ...(saved
        ? {}
        : {
            runtime_epoch: "live-epoch",
            part_index: 0,
            content_source: "response" as const,
            content_version: version,
          }),
    });
    vi.mocked(backend.agentHistoryRead).mockImplementation(async () => {
      const value = read(4, [
        { part_kind: "text", content: reference() as unknown as HistoryValue },
      ]);
      value.run.status = "running";
      if (!value.request?.response) throw new Error("Response is missing");
      value.request.response_saved = saved;
      value.request.response.saved = saved;
      return value;
    });
    const pending =
      deferred<Awaited<ReturnType<typeof backend.agentHistoryText>>>();
    const text = vi
      .spyOn(backend, "agentHistoryText")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        offset: 2,
        next_offset: 4,
        total_bytes: 4,
        value: "OK",
        has_more: false,
      });
    mount();
    const original = await testing.screen.findByText("v1");
    const article = original.closest("article");
    expect(testing.screen.getByText("Not saved")).toBeTruthy();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load more text" }),
    );
    await testing.waitFor(() => expect(text).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    version = "v2";
    await event({ type: "usage.updated", agent_id: 2, sequence: 4 });
    await testing.act(async () => vi.advanceTimersByTimeAsync(150));
    expect(testing.screen.getByText("v2").closest("article")).toBe(article);
    await testing.act(async () =>
      pending.resolve({
        offset: 2,
        next_offset: 4,
        total_bytes: 4,
        value: "OLD",
        has_more: false,
      }),
    );
    expect(testing.screen.queryByText("v1OLD")).toBeNull();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load more text" }),
    );
    await testing.act(async () => {});
    expect(testing.screen.getByText("v2OK")).toBeTruthy();
    expect(text.mock.calls[0][2].content_version).toBe("v1");
    expect(text.mock.calls[1][2].content_version).toBe("v2");
    saved = true;
    await event({ type: "turn.finished", agent_id: 2, sequence: 4 });
    expect(testing.screen.queryByText("Not saved")).toBeNull();
    expect(testing.screen.getByText("v2").closest("article")).toBe(article);
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load more text" }),
    );
    await testing.act(async () => {});
    expect(text.mock.calls[2][2].source).toBe("response");
    expect(text.mock.calls[2][2].content_version).toBeUndefined();
    expect(testing.screen.getByText("v2OK")).toBeTruthy();
  });

  it("replaces temporary image versions and ignores an earlier image response", async () => {
    let version = "v1";
    vi.mocked(backend.agentHistoryRead).mockImplementation(async () =>
      command({
        kind: "binary",
        source: "live",
        runtime_epoch: "live-epoch",
        content_source: "tool",
        content_version: version,
        part_index: 0,
        request_ordinal: 1,
        message_index: 0,
        path: ["parts", 0, "content"],
        media_type: "image/png",
        size: 3,
        identifier: null,
      }),
    );
    const pending =
      deferred<Awaited<ReturnType<typeof backend.agentHistoryImage>>>();
    const image = vi
      .spyOn(backend, "agentHistoryImage")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        media_type: "image/png",
        data: "bmV3",
        size: 3,
        identifier: null,
      });
    mount();
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: /Read file docs/ }),
    );
    await testing.waitFor(() => expect(image).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    version = "v2";
    await event({ type: "tool.updated", agent_id: 2, sequence: 4 });
    await testing.act(async () => vi.advanceTimersByTimeAsync(150));
    expect(testing.screen.getByRole("img").getAttribute("src")).toBe(
      "data:image/png;base64,bmV3",
    );
    await testing.act(async () =>
      pending.resolve({
        media_type: "image/png",
        data: "b2xk",
        size: 3,
        identifier: null,
      }),
    );
    expect(testing.screen.getByRole("img").getAttribute("src")).toBe(
      "data:image/png;base64,bmV3",
    );
    expect(image.mock.calls[0][2].content_version).toBe("v1");
    expect(image.mock.calls[1][2].content_version).toBe("v2");
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: /Read file docs/ }),
    );
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: /Read file docs/ }),
    );
    await testing.act(async () => {});
    expect(image).toHaveBeenCalledTimes(2);
  });

  it("clears temporary response content on disconnect and reads a new Core epoch", async () => {
    let epoch = "first";
    let content = "Temporary first response";
    const saved = false;
    vi.mocked(backend.agentHistoryRead).mockImplementation(async () => {
      const value = read(4, [{ part_kind: "text", content }]);
      value.run.status = "running";
      if (!value.request?.response) throw new Error("Response is missing");
      value.request.response_saved = saved;
      value.request.response.saved = saved;
      value.request.observation = {
        runtime_epoch: epoch,
        live_revision: 1,
        request_id: "request",
      };
      return value;
    });
    mount();
    await testing.screen.findByText(content);
    await event({ type: "connection.closed" });
    expect(testing.screen.queryByText(content)).toBeNull();
    epoch = "second";
    content = "Temporary second response";
    await event({ type: "connection.restored" });
    expect(await testing.screen.findByText(content)).toBeTruthy();
    expect(testing.screen.queryByText("Temporary first response")).toBeNull();
    expect(testing.screen.getByText("Not saved")).toBeTruthy();
  });

  it("keeps initial saved-content placeholders distinct from a retained-content refresh", async () => {
    const initial = deferred<AgentHistoryRead>();
    const refresh = deferred<AgentHistoryRead>();
    vi.mocked(backend.agentHistoryRead)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise);
    mount();
    const reading = await testing.screen.findByLabelText(
      "Reading saved activity",
    );
    const reminder = testing.screen.getByLabelText("Loading reminder");
    expect(reading.getAttribute("aria-busy")).toBe("true");
    expect(reminder.getAttribute("aria-busy")).toBe("true");
    expect(reading.querySelector("button,input,select,[tabindex]")).toBeNull();
    expect(reminder.querySelector("button,input,select,[tabindex]")).toBeNull();
    expect(testing.screen.queryByText("No saved reminder")).toBeNull();
    await testing.act(async () =>
      initial.resolve(
        read(4, [{ part_kind: "text", content: "已保存完整正文" }]),
      ),
    );
    const body = await testing.screen.findByText("已保存完整正文");
    const node = body.closest("article");
    expect(
      testing.screen.queryByLabelText("Reading saved activity"),
    ).toBeNull();
    expect(testing.screen.queryByLabelText("Loading reminder")).toBeNull();
    await event({ type: "turn.progress", agent_id: 2, sequence: 4 });
    await testing.screen.findByLabelText("Reading saved activity");
    expect(testing.screen.getByText("已保存完整正文").closest("article")).toBe(
      node,
    );
    expect(
      testing.screen
        .getByLabelText("Reading saved activity")
        .getAttribute("aria-busy"),
    ).toBeNull();
    expect(testing.screen.queryByLabelText("Loading reminder")).toBeNull();
    await testing.act(async () =>
      refresh.resolve(
        read(4, [{ part_kind: "text", content: "已保存完整正文" }]),
      ),
    );
    expect(testing.screen.getByText("已保存完整正文").closest("article")).toBe(
      node,
    );
    expect(
      testing.screen.queryByLabelText("Reading saved activity"),
    ).toBeNull();
  });

  it.each(["failure", "disconnect"] as const)(
    "ends initial saved-content placeholders after %s",
    async (outcome) => {
      const pending = deferred<AgentHistoryRead>();
      vi.mocked(backend.agentHistoryRead).mockReturnValue(pending.promise);
      mount();
      await testing.screen.findByLabelText("Loading reminder");
      expect(
        testing.screen.getByLabelText("Reading saved activity"),
      ).toBeTruthy();
      if (outcome === "failure") {
        await testing.act(async () =>
          pending.reject(
            new BackendError("timeout", "Saved history timed out"),
          ),
        );
        expect(
          await testing.screen.findByText("Saved history timed out"),
        ).toBeTruthy();
        expect(
          testing.screen.getByRole("button", { name: "Retry reminder" }),
        ).toBeTruthy();
      } else {
        vi.spyOn(backend, "disconnected", "get").mockReturnValue(true);
        await event({ type: "connection.closed" });
      }
      expect(testing.screen.queryByLabelText("Loading reminder")).toBeNull();
      expect(
        testing.screen.queryByLabelText("Reading saved activity"),
      ).toBeNull();
      expect(testing.screen.queryByText("No saved reminder")).toBeNull();
    },
  );

  it("keeps window and conversation reads distinct from confirmed empty history", async () => {
    const windows = deferred<AgentHistoryWindows>();
    const history = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistoryWindows).mockReturnValue(windows.promise);
    vi.mocked(backend.agentHistory).mockReturnValue(history.promise);
    mount();
    const pending = testing.screen.getByLabelText("Loading windows");
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.querySelector("button,input,select,[tabindex]")).toBeNull();
    expect(testing.screen.queryByText("No activity yet")).toBeNull();
    expect(backend.agentHistory).not.toHaveBeenCalled();
    await testing.act(async () => windows.resolve(directory()));
    expect(testing.screen.getByLabelText("Context window")).toBeTruthy();
    expect(testing.screen.queryByLabelText("Loading windows")).toBeNull();
    expect(
      testing.screen.getByLabelText("Loading window history"),
    ).toBeTruthy();
    expect(testing.screen.queryByText("No activity yet")).toBeNull();
    await testing.act(async () => history.resolve(page(1, [])));
    expect(
      testing.screen.queryByLabelText("Loading window history"),
    ).toBeNull();
    expect(testing.screen.getByText("No activity yet")).toBeTruthy();
  });

  it("retries the window directory locally and retains the selected content during refresh", async () => {
    const refresh = deferred<AgentHistoryWindows>();
    vi.mocked(backend.agentHistoryWindows)
      .mockRejectedValueOnce(new BackendError("timeout", "Directory timed out"))
      .mockResolvedValueOnce(directory())
      .mockReturnValueOnce(refresh.promise);
    mount();
    expect(await testing.screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Directory timed out",
    );
    expect(testing.screen.queryByLabelText("Loading windows")).toBeNull();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry windows" }),
    );
    const content = await testing.screen.findByText("发布说明已完成", {
      exact: false,
    });
    const selection = testing.screen.getByLabelText("Context window");
    await event({ type: "turn.progress", agent_id: 2, sequence: 4 });
    expect(testing.screen.getByLabelText("Context window")).toBe(selection);
    expect(testing.screen.getByText("发布说明已完成", { exact: false })).toBe(
      content,
    );
    expect(testing.screen.queryByLabelText("Loading windows")).toBeNull();
    expect(
      testing.screen.queryByLabelText("Loading window history"),
    ).toBeNull();
    await testing.act(async () => refresh.resolve(directory()));
    expect(testing.screen.getByLabelText("Context window")).toBe(selection);
    expect(testing.screen.getByText("发布说明已完成", { exact: false })).toBe(
      content,
    );
  });

  it.each([
    ["view_image", { path: "library/社区网站/发布页面.png" }],
    ["run", { argv: ["cat", "library/社区网站/新成员指南.md"] }],
    ["custom_action_with_a_long_unbroken_saved_name", { path: "保存参数" }],
  ])(
    "bounds narrow %s actions and preserves expanded content",
    async (tool, args) => {
      const output = "完整保存的工具结果与第二级内容保持可读。";
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(
        read(
          4,
          [
            {
              part_kind: "tool-call",
              tool_name: tool,
              tool_call_id: "narrow",
              args,
            },
          ],
          [
            {
              part_kind: "tool-return",
              tool_name: tool,
              tool_call_id: "narrow",
              content: output,
            },
          ],
        ),
      );
      mount();
      const toggle = await testing.screen.findByRole("button", {
        name: /Result saved/,
      });
      const bubble = toggle.parentElement?.parentElement;
      expect(bubble?.classList.contains("w-fit")).toBe(true);
      expect(
        bubble?.classList.contains("[@media(max-width:640px)]:max-w-full"),
      ).toBe(true);
      expect(
        toggle.classList.contains("[@media(max-width:640px)]:max-w-full"),
      ).toBe(true);
      const title = toggle.querySelector("span.flex-1");
      expect(title?.classList.contains("truncate")).toBe(true);
      expect(
        title?.classList.contains(
          "[@media(max-width:640px)]:whitespace-normal",
        ),
      ).toBe(true);
      expect(
        title?.classList.contains("[@media(max-width:640px)]:wrap-anywhere"),
      ).toBe(true);
      testing.fireEvent.click(toggle);
      await testing.screen.findByText(output);
      const details = toggle.parentElement?.querySelector("div.mt-2");
      expect(details?.classList.contains("overflow-x-auto")).toBe(true);
      expect(details?.classList.contains("min-w-0")).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      testing.fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      testing.fireEvent.click(toggle);
      await testing.screen.findByText(output);
      expect(toggle.parentElement?.parentElement).toBe(bubble);
    },
  );
  it("keeps the saved action node when an empty associated result becomes available", async () => {
    const initial = command("unused");
    if (!initial.request) throw new Error("Saved request is missing");
    initial.request.related = empty;
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(initial);
    mount();
    const toggle = await testing.screen.findByRole("button", {
      name: /Read file docs/,
    });
    const node = toggle.closest("article");
    const updated = command(
      JSON.stringify({ stdout: "新增保存结果", stderr: "", exit_code: 0 }),
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(updated);
    await event({
      type: "turn.progress",
      agent_id: 2,
      sequence: 4,
    } as BackendEvent);
    const current = await testing.screen.findByRole("button", {
      name: /Read file docs.*Result saved/,
    });
    expect(current.closest("article")).toBe(node);
    testing.fireEvent.click(current);
    expect(await testing.screen.findByText("新增保存结果")).toBeTruthy();
    expect(testing.screen.queryByText(/Saved complete context/)).toBeNull();
  });

  it("orders successful replies by saved result positions and retains their nodes while new saved content arrives", async () => {
    const calls = [14, 15].map((id) => ({
      part_kind: "tool-call",
      tool_name: "discussion",
      tool_call_id: `send-${id}`,
      args: {
        action: "send",
        discussion_id: 8,
        body: id === 15 ? "较早发送的回复" : "随后发送的回复",
      },
    }));
    const receipts = [15, 14].map((id) => ({
      part_kind: "tool-return",
      tool_name: "discussion",
      tool_call_id: `send-${id}`,
      content: {
        discussion_id: 8,
        id,
        created_at: id === 15 ? "2026-10-08T09:16:00Z" : "2026-10-08T09:17:00Z",
      },
    }));
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(4, calls, receipts),
    );
    const current = vi.spyOn(backend, "discussionPage");
    mount();
    const earlier = await testing.screen.findByText("较早发送的回复");
    const node = earlier.closest("article");
    await testing.screen.findByText("随后发送的回复");
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(
        4,
        [...calls, { part_kind: "text", content: "通知记录已经保存" }],
        receipts,
      ),
    );
    await event({
      type: "turn.progress",
      agent_id: 2,
      sequence: 4,
    } as BackendEvent);
    await testing.screen.findByText("通知记录已经保存");
    const replies = testing.screen
      .getAllByRole("article", { name: "Agent message" })
      .filter((reply) => reply.textContent?.includes("Sent to"));
    expect(replies.map((reply) => reply.textContent)).toEqual([
      expect.stringContaining("较早发送的回复"),
      expect.stringContaining("随后发送的回复"),
    ]);
    expect(earlier.closest("article")).toBe(node);
    expect(
      replies.map((reply) => reply.querySelector("time")?.dateTime),
    ).toEqual(["2026-10-08T09:16:00Z", "2026-10-08T09:17:00Z"]);
    expect(current).not.toHaveBeenCalled();
    expect(
      testing.screen.queryByRole("button", { name: /Send to/ }),
    ).toBeNull();
  });

  it.each(["success", "failure"])(
    "resumes Unicode text at its interrupted cursor and ignores a late %s",
    async (outcome) => {
      const text: HistoryText = {
        kind: "text",
        source: "response",
        request_ordinal: 1,
        message_index: 0,
        path: ["parts", 0, "content"],
        offset: 0,
        next_offset: 6,
        total_bytes: 12,
        value: "中文",
        has_more: true,
      };
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(
        read(4, [
          { part_kind: "text", content: text as unknown as HistoryValue },
        ]),
      );
      const pending =
        deferred<Awaited<ReturnType<typeof backend.agentHistoryText>>>();
      const continuation = vi
        .spyOn(backend, "agentHistoryText")
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue({
          offset: 6,
          next_offset: 12,
          total_bytes: 12,
          value: "内容",
          has_more: false,
        });
      mount();
      const body = await testing.screen.findByText("中文");
      const node = body.closest("article");
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Load more text" }),
      );
      await testing.waitFor(() => expect(continuation).toHaveBeenCalledOnce());
      await event({ type: "connection.closed" });
      expect(testing.screen.getByText("中文").closest("article")).toBe(node);
      await event({ type: "connection.restored" });
      await testing.screen.findByText("中文内容");
      await testing.act(async () => {
        if (outcome === "success") {
          pending.resolve({
            offset: 6,
            next_offset: 12,
            total_bytes: 12,
            value: "过期",
            has_more: false,
          });
        } else pending.reject(new Error("Interrupted text error"));
      });
      expect(continuation.mock.calls.map((call) => call[2].offset)).toEqual([
        6, 6,
      ]);
      expect(testing.screen.getByText("中文内容").closest("article")).toBe(
        node,
      );
      expect(testing.screen.queryByText("中文过期")).toBeNull();
      expect(testing.screen.queryByText("Interrupted text error")).toBeNull();
    },
  );

  it("keeps a saved Reminder while reconnecting and ignores its interrupted history response", async () => {
    const reminder = "保存的提醒原文与消息清单";
    const value = withReminder(
      read(4, [{ part_kind: "text", content: "工作记录" }]),
      reminder,
    );
    const pending = deferred<AgentHistoryRead>();
    const source = vi
      .mocked(backend.agentHistoryRead)
      .mockResolvedValueOnce(value)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(value);
    const current = vi.spyOn(backend, "discussionPage");
    mount();
    const body = await testing.screen.findByText(reminder);
    const node = body.closest("article");
    await event({ type: "connection.closed" });
    await event({ type: "connection.restored" });
    await testing.waitFor(() => expect(source).toHaveBeenCalledTimes(2));
    await event({ type: "connection.closed" });
    expect(testing.screen.getByText(reminder).closest("article")).toBe(node);
    await event({ type: "connection.restored" });
    await testing.waitFor(() => expect(source).toHaveBeenCalledTimes(3));
    await testing.act(async () =>
      pending.resolve(
        withReminder(
          read(4, [{ part_kind: "text", content: "过期的工作记录" }]),
          "过期的提醒原文",
        ),
      ),
    );
    expect(testing.screen.getByText(reminder).closest("article")).toBe(node);
    expect(testing.screen.queryByText("过期的提醒原文")).toBeNull();
    expect(testing.screen.queryByText("过期的工作记录")).toBeNull();
    expect(source.mock.calls[2]).toEqual(source.mock.calls[0]);
    expect(current).not.toHaveBeenCalled();
  });

  it("presents the complete saved command parameters and output", async () => {
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      command(JSON.stringify({ exit_code: 0, stdout: "命令执行完成" }), {
        argv: [
          "/project/fora/core/.venv/bin/python",
          "-c",
          "print('命令执行完成')",
        ],
        cwd: "/project/fora/.task-data/community-preview-data",
      }),
    );
    mount();
    const toggle = await testing.screen.findByRole("button", {
      name: "Run python · Result saved",
    });
    expect(
      testing.screen.queryByText("/project/fora/core/.venv/bin/python"),
    ).toBeNull();
    testing.fireEvent.click(toggle);
    expect(
      await testing.screen.findByText("/project/fora/core/.venv/bin/python"),
    ).toBeTruthy();
    expect(
      await testing.screen.findByText("print('命令执行完成')"),
    ).toBeTruthy();
    expect(
      await testing.screen.findByText(
        "/project/fora/.task-data/community-preview-data",
      ),
    ).toBeTruthy();
    expect(await testing.screen.findByText("命令执行完成")).toBeTruthy();
    expect(
      testing.screen.getByText("exit_code").parentElement?.querySelector("pre")
        ?.textContent,
    ).toBe("0");
    const details = toggle.closest("article");
    expect(details?.textContent).toContain("cwd");
    expect(details?.textContent).toContain("argv 1");
  });

  it.each([20, 40, 60])(
    "previews whole result lines at a measured body height of %ipx",
    async (height) => {
      const output = ["读取资料完成", "测试执行完成", "发布记录完成"]
        .slice(0, height / 20)
        .join("\n");
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return this.textContent === output ? height : 20;
        },
      );
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(
        command({ stdout: output, exit_code: 0 }),
      );
      mount();
      const action = await testing.screen.findByRole("button", {
        name: /Result saved/,
      });
      testing.fireEvent.click(action);
      const body = await testing.screen.findByText(output, {
        selector: "pre",
        normalizer: (value) => value,
      });
      const frame = body.closest(".relative");
      expect(body.classList.contains("leading-5")).toBe(true);
      expect(frame?.contains(testing.screen.getByText("stdout"))).toBe(false);
      expect(frame?.contains(testing.screen.getByText("exit_code"))).toBe(
        false,
      );
      expect(frame?.classList.contains("max-h-10")).toBe(height > 40);
      expect(frame?.querySelector(".bg-linear-to-t") !== null).toBe(
        height > 40,
      );
      if (height <= 40) {
        expect(
          testing.screen.queryByRole("button", { name: "Show more" }),
        ).toBeNull();
        return;
      }
      expect(frame?.querySelector(".from-app.h-5")).toBeTruthy();
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Show more" }),
      );
      expect(frame?.classList.contains("max-h-10")).toBe(false);
      expect(frame?.querySelector(".bg-linear-to-t")).toBeNull();
      testing.fireEvent.click(action);
      testing.fireEvent.click(action);
      expect(
        await testing.screen.findByRole("button", { name: "Show less" }),
      ).toBeTruthy();
      const restored = testing.screen.getByText(output, {
        selector: "pre",
        normalizer: (value) => value,
      });
      expect(
        restored.closest(".relative")?.classList.contains("max-h-10"),
      ).toBe(false);
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Show less" }),
      );
      expect(
        restored.closest(".relative")?.classList.contains("max-h-10"),
      ).toBe(true);
    },
  );

  it("expands result fields independently and preserves them when switching windows", async () => {
    const output = "读取资料完成\n测试执行完成\n发布记录完成";
    const error = "附件读取失败\n保留当前正文\n可以重新读取";
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return [output, error].includes(this.textContent ?? "") ? 60 : 20;
      },
    );
    vi.mocked(backend.agentHistoryWindows).mockResolvedValue(directory([2, 1]));
    vi.mocked(backend.agentHistory).mockImplementation(
      async (_agent, _before, _limit, _after, _windowsLimit, options) =>
        page(
          options?.window_number ?? 2,
          options?.window_number === 1 ? [] : [4],
        ),
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      command({ stdout: output, stderr: error, exit_code: 1 }),
    );
    mount();
    const action = await testing.screen.findByRole("button", {
      name: /Result saved/,
    });
    testing.fireEvent.click(action);
    const body = await testing.screen.findByText(output, {
      selector: "pre",
      normalizer: (value) => value,
    });
    const failed = testing.screen.getByText(error, {
      selector: "pre",
      normalizer: (value) => value,
    });
    const expanded = body.closest(".relative")?.parentElement;
    if (!expanded) throw new Error("Output controls are unavailable");
    testing.fireEvent.click(
      testing.within(expanded).getByRole("button", { name: "Show more" }),
    );
    expect(failed.closest(".relative")?.classList.contains("max-h-10")).toBe(
      true,
    );
    const picker = testing.screen.getByRole("combobox", {
      name: "Context window",
    });
    await chooseWindow(picker, "1");
    await testing.screen.findByText("No activity yet");
    await chooseWindow(picker, "2");
    await testing.screen.findByRole("button", { name: "Show less" });
    expect(
      testing.screen.getAllByRole("button", { name: "Show more" }),
    ).toHaveLength(1);
    expect(
      testing.screen.getByText("exit_code").parentElement?.querySelector("pre")
        ?.textContent,
    ).toBe("1");
  });

  it("preserves paged result text while expanding and reopening its action", async () => {
    const output = "读取资料完成\n测试执行完成\n发布记录完成";
    const suffix = "\n附件核验完成";
    const offset = new TextEncoder().encode(output).length;
    const total = offset + new TextEncoder().encode(suffix).length;
    const reference: HistoryText = {
      kind: "text",
      source: "related",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 0, "content"],
      offset: 0,
      next_offset: offset,
      total_bytes: total,
      value: output,
      has_more: true,
    };
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.querySelector("pre")?.textContent?.startsWith(output)
          ? 80
          : 20;
      },
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(
        4,
        [
          {
            part_kind: "tool-call",
            tool_name: "inspect_file",
            tool_call_id: "inspect",
            args: {},
          },
        ],
        [
          {
            part_kind: "tool-return",
            tool_name: "inspect_file",
            tool_call_id: "inspect",
            content: reference,
          },
        ],
      ),
    );
    const continuation = vi
      .spyOn(backend, "agentHistoryText")
      .mockResolvedValue({
        offset,
        next_offset: total,
        total_bytes: total,
        value: suffix,
        has_more: false,
      });
    mount();
    const action = await testing.screen.findByRole("button", {
      name: "inspect_file · Result saved",
    });
    testing.fireEvent.click(action);
    const body = await testing.screen.findByText(output, {
      selector: "pre",
      normalizer: (value) => value,
    });
    expect(body.classList.contains("leading-5")).toBe(true);
    expect(body.closest(".relative")?.classList.contains("max-h-10")).toBe(
      true,
    );
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Show more" }),
    );
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load more text" }),
    );
    await testing.screen.findByText(output + suffix, {
      selector: "pre",
      normalizer: (value) => value,
    });
    expect(continuation.mock.calls[0][2].offset).toBe(offset);
    testing.fireEvent.click(action);
    testing.fireEvent.click(action);
    const restored = await testing.screen.findByText(output + suffix, {
      selector: "pre",
      normalizer: (value) => value,
    });
    expect(restored.closest(".relative")?.classList.contains("max-h-10")).toBe(
      false,
    );
    expect(
      testing.screen.queryByRole("button", { name: "Load more text" }),
    ).toBeNull();
    expect(continuation).toHaveBeenCalledOnce();
  });

  it("retains the 300px expansion threshold for command details", async () => {
    const argv = ["printf", "较长的命令参数".repeat(80)];
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.textContent?.includes(argv[1]) ? 320 : 20;
      },
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      command({ stdout: "命令执行完成", exit_code: 0 }, { argv }),
    );
    mount();
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: /Result saved/ }),
    );
    await testing.screen.findByText("命令执行完成");
    const body = testing.screen.getByText(argv[1], {
      selector: "pre",
    });
    const frame = body.closest(".relative");
    expect(frame?.classList.contains("max-h-[300px]")).toBe(true);
    expect(frame?.querySelector(".from-surface-raised.h-12")).toBeTruthy();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Show more" }),
    );
    expect(frame?.classList.contains("max-h-[300px]")).toBe(false);
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Show less" }),
    );
    expect(frame?.classList.contains("max-h-[300px]")).toBe(true);
  });

  it.each([
    { argv: ["python", "-c", "print('library/core/example')"] },
    { argv: ["printf", "%s", "category/tmp/example"] },
    { argv: ["curl", "https://example.com/library/core/tmp/example"] },
    { argv: ["cat", "/project/fora/library/社区网站/交接记录.md"] },
  ])("preserves every saved argument for $argv", async ({ argv }) => {
    const value = command({ exit_code: 0, stdout: "读取完成" }, { argv });
    const original = JSON.stringify(value);
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    mount();
    const toggle = await testing.screen.findByRole("button", {
      name: /Result saved/,
    });
    testing.fireEvent.click(toggle);
    for (const argument of argv)
      expect(
        (await testing.screen.findAllByText(argument, { selector: "pre" }))
          .length,
      ).toBeGreaterThan(0);
    expect(await testing.screen.findByText("读取完成")).toBeTruthy();
    expect(JSON.stringify(value)).toBe(original);
  });

  it.each([
    "print('/tmp/example')",
    "print('/project/fora/library/core/example')",
    "print('core/.venv/bin/python')",
  ])(
    "preserves complete saved code parameters and a failed command result for %s",
    async (code) => {
      const argv = ["python", "-c", code];
      const value = command(
        JSON.stringify({ exit_code: 2, stdout: "", stderr: "无法读取文件" }),
        { argv },
      );
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
      mount();
      testing.fireEvent.click(
        await testing.screen.findByRole("button", { name: /Run python/ }),
      );
      expect(
        await testing.screen.findByText(code, { selector: "pre" }),
      ).toBeTruthy();
      await testing.screen.findByText("exit_code");
      expect(
        testing.screen
          .getByText("exit_code")
          .parentElement?.querySelector("pre")?.textContent,
      ).toBe("2");
      expect(await testing.screen.findByText("无法读取文件")).toBeTruthy();
      expect(
        await testing.screen.findByRole("button", {
          name: "Run python · Result saved",
        }),
      ).toBeTruthy();
      expect(JSON.stringify(value)).toContain(
        JSON.stringify(code).slice(1, -1),
      );
    },
  );

  it("shows complete saved file changes and message attachment fields", async () => {
    const path =
      "/project/fora/.task-data/community-preview-data/library/社区网站/交接记录.md";
    const value = read(
      4,
      [
        {
          part_kind: "tool-call",
          tool_name: "edit",
          tool_call_id: "edit",
          args: {
            path,
            edits: [{ old_text: "等待检查", new_text: "附件检查已经完成" }],
          },
        },
        {
          part_kind: "tool-call",
          tool_name: "discussion",
          tool_call_id: "messages",
          args: { action: "read", discussion_id: 8 },
        },
      ],
      [
        {
          part_kind: "tool-return",
          tool_name: "edit",
          tool_call_id: "edit",
          content: JSON.stringify({
            path,
            diff: `--- ${path}\n+++ ${path}\n-等待检查\n+附件检查已经完成`,
            replacements: 1,
            created: false,
          }),
        },
        {
          part_kind: "tool-return",
          tool_name: "discussion",
          tool_call_id: "messages",
          content: JSON.stringify({
            id: 8,
            messages: [
              {
                sender_name: "林小雨",
                body: "请查看配图",
                attachments: [
                  {
                    name: "发布页面.png",
                    path: "/project/fora/uploads/saved-image",
                  },
                ],
              },
            ],
          }),
        },
      ],
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    mount();
    const edit = await testing.screen.findByRole("button", {
      name: "Edit file library/社区网站/交接记录.md · Result saved",
    });
    testing.fireEvent.click(edit);
    await testing.screen.findByText("附件检查已经完成");
    await testing.screen.findByText("created");
    expect(
      testing.screen.getByText("created").parentElement?.querySelector("pre")
        ?.textContent,
    ).toBe("false");
    expect(edit.closest("article")?.textContent).toContain(path);
    testing.fireEvent.click(
      await testing.screen.findByRole("button", {
        name: "Read Discussion 8 · Result saved",
      }),
    );
    await testing.screen.findByText("请查看配图");
    expect(await testing.screen.findByText("发布页面.png")).toBeTruthy();
    expect(testing.screen.getByRole("feed").textContent).toContain(
      "/project/fora/uploads/saved-image",
    );
    expect(JSON.stringify(value)).toContain(path);
  });

  it("keeps the selected window date distinct from its option descriptions and supports keyboard selection", async () => {
    vi.mocked(backend.agentHistoryWindows).mockResolvedValue(
      directory([3, 2, 1], 3),
    );
    vi.mocked(backend.agentHistory).mockImplementation(
      async (_id, _before, _limit, _after, _windowsLimit, options) =>
        page(options?.window_number ?? 3, []),
    );
    mount();
    const select = await testing.screen.findByRole("combobox", {
      name: "Context window",
    });
    await testing.waitFor(() =>
      expect((select as HTMLButtonElement).value).toBe("3"),
    );
    expect(select.querySelector("span.truncate")?.textContent).not.toContain(
      "In progress",
    );
    expect(testing.within(select).getByText("In progress").className).toBe(
      "sr-only",
    );
    select.focus();
    testing.fireEvent.keyDown(select, { key: "ArrowDown" });
    const list = await testing.screen.findByRole("listbox", {
      name: "Context windows",
    });
    expect(
      testing
        .within(list)
        .getByRole("option", { name: /In progress/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      testing.within(list).getAllByRole("option", { name: /Overflow rebuild/ }),
    ).toHaveLength(2);
    testing.fireEvent.keyDown(select, { key: "End" });
    expect(select.getAttribute("aria-activedescendant")).toBe(
      testing.within(list).getAllByRole("option")[2].id,
    );
    testing.fireEvent.keyDown(select, { key: "Enter" });
    await testing.waitFor(() =>
      expect((select as HTMLButtonElement).value).toBe("1"),
    );
    expect(testing.within(select).queryByText("In progress")).toBeNull();
    expect(select.textContent).not.toContain("Overflow rebuild");
    expect(document.activeElement).toBe(select);
    testing.fireEvent.keyDown(select, { key: "Home" });
    await testing.screen.findByRole("listbox", { name: "Context windows" });
    testing.fireEvent.keyDown(select, { key: "ArrowUp" });
    testing.fireEvent.keyDown(select, { key: "ArrowDown" });
    testing.fireEvent.keyDown(select, { key: "Escape" });
    await testing.waitFor(() =>
      expect(
        testing.screen.queryByRole("listbox", { name: "Context windows" }),
      ).toBeNull(),
    );
    expect((select as HTMLButtonElement).value).toBe("1");
    expect(document.activeElement).toBe(select);
  });

  it.each(["pointer", "Tab", "Shift+Tab"])(
    "keeps the user's destination and reading position after %s leaves the window list",
    async (method) => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("conversation-scroll") ? 1800 : 100;
        },
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("conversation-scroll") ? 500 : 100;
        },
      );
      const user = userEvent.setup({ document });
      mount(true, true);
      await testing.screen.findByText("校验");
      const select = testing.screen.getByRole("combobox", {
        name: "Context window",
      });
      const scroll = testing.screen.getByTestId("scroll");
      scroll.scrollTop = 400;
      testing.fireEvent.scroll(scroll);
      await user.click(select);
      await testing.screen.findByRole("listbox", { name: "Context windows" });
      expect(scroll.scrollTop).toBe(400);
      const target = testing.screen.getByRole("textbox", {
        name: method === "Shift+Tab" ? "Before history" : "After history",
      });
      if (method === "pointer") await user.click(target);
      else await user.tab({ shift: method === "Shift+Tab" });
      await testing.waitFor(() =>
        expect(
          testing.screen.queryByRole("listbox", { name: "Context windows" }),
        ).toBeNull(),
      );
      if (method === "Tab") {
        expect(document.activeElement).toBe(
          testing.screen.getByRole("button", { name: "Copy message text" }),
        );
        expect(scroll.scrollTop).toBe(400);
        await user.tab();
      }
      await user.keyboard("继续阅读");
      expect(document.activeElement).toBe(target);
      expect((target as HTMLInputElement).value).toBe("继续阅读");
      expect(scroll.scrollTop).toBe(400);
      expect((select as HTMLButtonElement).value).toBe("1");
      await user.click(select);
      const list = await testing.screen.findByRole("listbox", {
        name: "Context windows",
      });
      await user.click(testing.within(list).getByRole("option"));
      await testing.waitFor(() => expect(document.activeElement).toBe(select));
      expect(scroll.scrollTop).toBe(400);
      await user.click(select);
      await testing.screen.findByRole("listbox", { name: "Context windows" });
      await user.keyboard("{Escape}");
      await testing.waitFor(() =>
        expect(
          testing.screen.queryByRole("listbox", { name: "Context windows" }),
        ).toBeNull(),
      );
      expect(document.activeElement).toBe(select);
      expect(scroll.scrollTop).toBe(400);
    },
  );

  it("renders saved command output after reading structured data", async () => {
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      command(
        JSON.stringify({ exit_code: 1, stdout: "", stderr: "文件尚未保存" }),
      ),
    );
    mount();
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: /Read file docs/ }),
    );
    expect(
      await testing.screen.findByRole("button", {
        name: "Read file docs/发布说明.md · Result saved",
      }),
    ).toBeTruthy();
    expect(await testing.screen.findByText("文件尚未保存")).toBeTruthy();
  });

  it(
    "connects earlier history controls to overlapping refreshes and fills the retained gap",
    workflow(async (scope) => {
      const pending = ownedHistoryPage(scope, page(1, [2, 1]));
      let refreshed = false;
      vi.mocked(backend.agentHistory).mockImplementation(
        async (_agent, before) => {
          if (before === 3) return pending.promise;
          if (before === 8) return page(1, [7, 6, 5], true);
          return page(1, refreshed ? [10, 9, 8] : [5, 4, 3], true);
        },
      );
      vi.mocked(backend.agentHistoryRead).mockImplementation(
        async (_agent, sequence) =>
          read(sequence, [
            { part_kind: "text", content: `记录正文 ${sequence}` },
          ]),
      );
      let mounted!: ReturnType<typeof mount>;
      await complete(scope, async () => {
        mounted = mount();
      });
      const original = testing.screen.getByText("记录正文 5");
      const opener = testing.screen.getByRole("button", {
        name: "Load earlier history",
      });
      const controls = opener.parentElement;
      if (!controls) throw new Error("History controls are missing");
      const earlier = () => {
        const button = testing.within(controls).getByRole("button", {
          name: /Load earlier history$/,
        });
        expect(button.isConnected).toBe(true);
        return button;
      };
      await complete(scope, async () => {
        testing.fireEvent.click(earlier());
      });
      expect(earlier()).toBe(opener);
      expect(opener.hasAttribute("disabled")).toBe(true);
      refreshed = true;
      await complete(scope, async () => {
        mounted.rerender(view([{ ...run(10), effects: [] }]));
      });
      expect(testing.screen.getByText("记录正文 10")).toBeTruthy();
      expect(testing.screen.getByText("记录正文 5")).toBe(original);
      expect(earlier()).toBe(opener);
      await complete(scope, async () => pending.resolve(page(1, [2, 1])));
      expect(testing.screen.getByText("记录正文 1")).toBeTruthy();
      expect(testing.screen.queryByText("记录正文 6")).toBeNull();
      expect(testing.screen.queryByText("记录正文 7")).toBeNull();
      expect(earlier()).toBe(opener);
      await complete(scope, async () => {
        testing.fireEvent.click(earlier());
      });
      for (const sequence of [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
        expect(
          testing.screen.getAllByText(`记录正文 ${sequence}`),
        ).toHaveLength(1);
      }
      expect(testing.screen.getByText("记录正文 5")).toBe(original);
      expect(
        vi.mocked(backend.agentHistory).mock.calls.map((call) => call[1]),
      ).toEqual([undefined, 3, undefined, 8]);
      expect(controls.isConnected).toBe(false);
      expect(
        testing.screen.queryByRole("button", { name: "Load earlier history" }),
      ).toBeNull();
    }),
  );

  it(
    "keeps a late earlier page isolated after the history view is unmounted and mounted again",
    workflow(async (scope) => {
      const pending = ownedHistoryPage(scope, page(1, [2, 1]));
      vi.mocked(backend.agentHistory)
        .mockResolvedValueOnce(page(1, [5, 4, 3], true))
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(page(1, [9]));
      vi.mocked(backend.agentHistoryRead).mockImplementation(
        async (_agent, sequence) =>
          read(sequence, [
            { part_kind: "text", content: `记录正文 ${sequence}` },
          ]),
      );
      let previous!: ReturnType<typeof mount>;
      await complete(scope, async () => {
        previous = mount();
      });
      const earlier = testing.screen.getByRole("button", {
        name: "Load earlier history",
      });
      await complete(scope, async () => {
        testing.fireEvent.click(earlier);
      });
      previous.unmount();
      expect(listeners.size).toBe(0);
      expect(observers.size).toBe(0);
      await complete(scope, async () => {
        mount();
      });
      const current = testing.screen.getByText("记录正文 9");
      const reads = vi.mocked(backend.agentHistoryRead).mock.calls.length;
      await complete(scope, async () => pending.resolve(page(1, [2, 1])));
      expect(testing.screen.getByText("记录正文 9")).toBe(current);
      expect(testing.screen.queryByText("记录正文 5")).toBeNull();
      expect(testing.screen.queryByText("记录正文 1")).toBeNull();
      expect(earlier.isConnected).toBe(false);
      expect(backend.agentHistory).toHaveBeenCalledTimes(3);
      expect(backend.agentHistoryRead).toHaveBeenCalledTimes(reads);
    }),
  );

  it("preserves the visible paragraph as earlier messages and later content increase the reading height", async () => {
    let shift = 0;
    let scroll: HTMLElement | null = null;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("conversation-scroll")
          ? 1800 + shift
          : 100;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("conversation-scroll") ? 500 : 100;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const top = this.classList.contains("conversation-scroll")
          ? 0
          : this.tagName === "P" && this.textContent === "保持阅读段落"
            ? 350 + shift - (scroll?.scrollTop ?? 0)
            : 2000;
        const height = this.classList.contains("conversation-scroll")
          ? 500
          : 30;
        return {
          x: 0,
          y: top,
          top,
          bottom: top + height,
          left: 0,
          right: 600,
          width: 600,
          height,
          toJSON: () => ({}),
        };
      },
    );
    vi.mocked(backend.agentHistory)
      .mockResolvedValueOnce(page(1, [4], true))
      .mockResolvedValue(page(1, [3]));
    vi.mocked(backend.agentHistoryRead).mockImplementation(
      async (_agent, sequence) =>
        read(sequence, [
          {
            part_kind: "text",
            content: sequence === 4 ? "保持阅读段落" : "更早消息",
          },
        ]),
    );
    mount(true);
    const paragraph = await testing.screen.findByText("保持阅读段落");
    scroll = testing.screen.getByTestId("scroll");
    scroll.scrollTop = 300;
    testing.fireEvent.scroll(scroll);
    const feed = testing.screen.getByRole("feed", { name: "Activity history" });
    const root = feed.parentElement;
    const resize =
      root && observers.has(root) ? () => resizeTarget(root) : undefined;
    if (!resize) throw new Error("Reading container observer is missing");
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load earlier history" }),
    );
    await testing.screen.findByText("更早消息");
    shift = 240;
    await testing.act(async () => resize());
    expect(scroll.scrollTop).toBe(540);
    expect(paragraph.getBoundingClientRect().top).toBe(50);
    shift = 320;
    await testing.act(async () => resize());
    expect(scroll.scrollTop).toBe(620);
    scroll.scrollTop = 580;
    testing.fireEvent.scroll(scroll);
    shift = 400;
    await testing.act(async () => resize());
    expect(scroll.scrollTop).toBe(660);
    expect(testing.screen.getByText("保持阅读段落")).toBe(paragraph);
  });

  it("reads an attachment from a deleted sender and returns focus after closing its image", async () => {
    const value = read(4, [{ part_kind: "text", content: "附件已读取" }]);
    value.run.reminded = [{ discussion_id: 8, message_id: 12 }];
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    const attachment = {
      id: "8d8f6b4f-c24d-44e1-8a32-661e6f314bc7",
      name: "发布页面.png",
      size: 68,
      media_type: "image/png",
      sha256: "sha256",
      width: 1,
      height: 1,
    };
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      discussionRead({
        ...message(12),
        sender_id: 77,
        sender_name: "陈沐",
        attachments: [attachment],
      }),
    );
    const file = vi
      .spyOn(backend, "attachmentFile")
      .mockRejectedValueOnce(new Error("Attachment interrupted"))
      .mockResolvedValue(
        new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:community-image");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const mounted = mount();
    testing.fireEvent.click(
      await testing.screen.findByRole("button", {
        name: "Read Discussion 8 · Result saved",
      }),
    );
    await testing.screen.findByText("Attachment interrupted");
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry preview" }),
    );
    const opener = await testing.screen.findByRole("button", {
      name: "View 发布页面.png",
    });
    await testing.waitFor(() =>
      expect(opener.hasAttribute("disabled")).toBe(false),
    );
    expect(testing.screen.getByText("陈沐")).toBeTruthy();
    expect(file.mock.calls[1].slice(0, 3)).toEqual([8, 12, attachment]);
    opener.focus();
    testing.fireEvent.click(opener);
    await testing.screen.findByRole("dialog", { name: "发布页面.png" });
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Close" }),
    );
    await testing.waitFor(() =>
      expect(testing.screen.queryByRole("dialog")).toBeNull(),
    );
    expect(document.activeElement).toBe(opener);
    mounted.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:community-image");
  });

  it("retries an unfinished thumbnail read and an image decoding failure without observer events", async () => {
    const value = read(4, [{ part_kind: "text", content: "配图准备完成" }]);
    value.run.reminded = [{ discussion_id: 8, message_id: 12 }];
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    const attachment = {
      id: "28b6d660-6d68-4d46-92e8-5f8eb75df871",
      name: "使用说明.png",
      size: 68,
      media_type: "image/png",
      sha256: "sha256",
      width: 720,
      height: 360,
    };
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      discussionRead({ ...message(12), attachments: [attachment] }),
    );
    const pending = deferred<Blob>();
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: "image/png",
    });
    const file = vi
      .spyOn(backend, "attachmentFile")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(blob);
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:ready")
      .mockReturnValueOnce("blob:recovered");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    mount();
    testing.fireEvent.click(
      await testing.screen.findByRole("button", {
        name: "Read Discussion 8 · Result saved",
      }),
    );
    await testing.waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    expect(
      testing.screen.getByRole("status", { name: "Loading image" }),
    ).toBeTruthy();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry preview" }),
    );
    await testing.waitFor(() => expect(file).toHaveBeenCalledTimes(2));
    expect(file.mock.calls[0][3]?.aborted).toBe(true);
    const image = await testing.screen.findByRole("img", {
      name: "使用说明.png",
    });
    expect(image.getAttribute("src")).toBe("blob:ready");
    await testing.act(async () => pending.resolve(blob));
    expect(create).toHaveBeenCalledTimes(1);
    testing.fireEvent.error(image);
    expect(
      testing.screen.queryByRole("img", { name: "使用说明.png" }),
    ).toBeNull();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry preview" }),
    );
    await testing.waitFor(() => expect(file).toHaveBeenCalledTimes(3));
    expect(
      (
        await testing.screen.findByRole("img", { name: "使用说明.png" })
      ).getAttribute("src"),
    ).toBe("blob:recovered");
    expect(revoke).toHaveBeenCalledWith("blob:ready");
  });

  it("retains the reply node and expanded command when later saved results arrive", async () => {
    const sendCall = {
      part_kind: "tool-call",
      tool_name: "discussion",
      tool_call_id: "send",
      args: { action: "send", discussion_id: 8, body: "保存的回复正文" },
    };
    const runCall = {
      part_kind: "tool-call",
      tool_name: "run",
      tool_call_id: "run",
      args: { argv: ["cat", "资料.md"] },
    };
    const receipt = {
      part_kind: "tool-return",
      tool_name: "discussion",
      tool_call_id: "send",
      content: { discussion_id: 8, id: 14, created_at: date },
    };
    const first = read(
      4,
      [sendCall, runCall],
      [
        receipt,
        {
          part_kind: "tool-return",
          tool_name: "run",
          tool_call_id: "run",
          content: { stdout: "资料正文", exit_code: 0 },
        },
      ],
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(first);
    vi.spyOn(backend, "discussionPage").mockResolvedValue({
      id: 8,
      messages: [message(14, 2, "保存的回复正文")],
    } as never);
    mount();
    const body = await testing.screen.findByText("保存的回复正文");
    const node = body.closest("article");
    const toggle = await testing.screen.findByRole("button", {
      name: "Read file 资料.md · Result saved",
    });
    testing.fireEvent.click(toggle);
    await testing.screen.findByText("资料正文");
    const next = read(
      4,
      [sendCall, runCall],
      [
        receipt,
        receipt,
        {
          part_kind: "tool-return",
          tool_name: "run",
          tool_call_id: "run",
          content: { stdout: "资料正文", exit_code: 0 },
        },
      ],
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(next);
    await event({
      type: "turn.progress",
      agent_id: 2,
      sequence: 4,
    } as BackendEvent);
    expect(testing.screen.getByText("保存的回复正文").closest("article")).toBe(
      node,
    );
    expect(testing.screen.getAllByText("保存的回复正文")).toHaveLength(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(testing.screen.getByText("资料正文")).toBeTruthy();
  });

  it("preserves expanded Markdown nodes while other records and its own content update", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.textContent?.startsWith("持续阅读") ? 600 : 100;
      },
    );
    vi.mocked(backend.agentHistory).mockResolvedValue(page(1, [4, 3]));
    let content = "持续阅读 **原始正文**";
    let other = "另一个记录";
    vi.mocked(backend.agentHistoryRead).mockImplementation(
      async (_agent, sequence) =>
        read(sequence, [
          { part_kind: "text", content: sequence === 4 ? content : other },
        ]),
    );
    mount();
    const strong = await testing.screen.findByText("原始正文");
    const article = strong.closest("article");
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: "Show more" }),
    );
    other = "另一个记录更新";
    await event({
      type: "turn.progress",
      agent_id: 2,
      sequence: 3,
    } as BackendEvent);
    await testing.screen.findByText(other);
    expect(testing.screen.getByText("原始正文")).toBe(strong);
    expect(
      testing.screen.getByRole("button", { name: "Show less" }),
    ).toBeTruthy();
    content = "持续阅读 **增量正文**";
    await event({
      type: "turn.progress",
      agent_id: 2,
      sequence: 4,
    } as BackendEvent);
    const updated = await testing.screen.findByText("增量正文");
    expect(updated).toBe(strong);
    expect(updated.closest("article")).toBe(article);
    expect(updated.getAttribute("data-streamdown")).toBe("strong");
    expect(updated.classList.contains("font-semibold")).toBe(true);
    expect(
      testing.screen.getByRole("button", { name: "Show less" }),
    ).toBeTruthy();
    expect(testing.screen.queryByText("原始正文")).toBeNull();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Show less" }),
    );
    expect(testing.screen.getByText("增量正文")).toBe(updated);
  });

  it("continues text through retry and growth while preserving its nodes during other updates", async () => {
    vi.mocked(backend.agentHistory).mockResolvedValue(page(1, [4, 3]));
    let reference: HistoryText = {
      kind: "text",
      source: "response",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 0, "content"],
      value: "中文",
      offset: 0,
      next_offset: 6,
      total_bytes: 12,
      has_more: true,
    };
    let other = "并行记录";
    vi.mocked(backend.agentHistoryRead).mockImplementation(
      async (_agent, sequence) =>
        read(sequence, [
          {
            part_kind: "text",
            content:
              sequence === 4 ? (reference as unknown as HistoryValue) : other,
          },
        ]),
    );
    let retryAllowed = false;
    const growth =
      deferred<Awaited<ReturnType<typeof backend.agentHistoryText>>>();
    const text = vi
      .spyOn(backend, "agentHistoryText")
      .mockImplementation(async (_agent, _sequence, saved) => {
        if (!retryAllowed)
          throw new BackendError("timeout", "Text timed out", true);
        return saved.offset === 6
          ? {
              offset: 6,
              next_offset: 12,
              total_bytes: reference.total_bytes,
              value: "内容",
              has_more: reference.total_bytes > 12,
            }
          : growth.promise;
      });
    mount();
    const body = await testing.screen.findByText("中文");
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: "Load more text" }),
    );
    await testing.screen.findByText("Text timed out");
    other = "并行记录更新";
    await event({
      type: "turn.progress",
      agent_id: 2,
      sequence: 3,
    } as BackendEvent);
    await testing.screen.findByText(other);
    expect(testing.screen.getByText("中文")).toBe(body);
    const failedReads = text.mock.calls.length;
    expect(text.mock.calls.map((call) => call[2].offset)).toEqual(
      Array.from({ length: failedReads }, () => 6),
    );
    retryAllowed = true;
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry text" }),
    );
    expect(await testing.screen.findByText("中文内容")).toBe(body);
    expect(text.mock.calls[failedReads][2].offset).toBe(6);
    await event({ type: "turn.progress", agent_id: 2, sequence: 4 });
    await testing.waitFor(() =>
      expect(testing.screen.queryByText("Text timed out")).toBeNull(),
    );
    expect(testing.screen.getByText("中文内容")).toBe(body);
    reference = { ...reference, total_bytes: 18 };
    await event({ type: "turn.progress", agent_id: 2, sequence: 4 });
    await testing.waitFor(() =>
      expect(text.mock.lastCall?.[2].offset).toBe(12),
    );
    expect(testing.screen.getByText("中文内容")).toBe(body);
    expect(
      testing.screen.getByLabelText("Reading saved activity"),
    ).toBeTruthy();
    await testing.act(async () =>
      growth.resolve({
        offset: 12,
        next_offset: 18,
        total_bytes: 18,
        value: "继续",
        has_more: false,
      }),
    );
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: "Load more text" }),
    );
    expect(await testing.screen.findByText("中文内容继续")).toBe(body);
    expect(text.mock.calls.map((call) => call[2].offset)).toEqual([
      ...Array.from({ length: failedReads }, () => 6),
      6,
      6,
      12,
    ]);
    expect(
      testing.screen.queryByRole("button", { name: "Load more text" }),
    ).toBeNull();
  });

  it("updates an unchanged action as saving completes and the run ends", async () => {
    const snapshot = read(4, [
      {
        part_kind: "tool-call",
        tool_name: "run",
        tool_call_id: "read",
        args: { argv: ["cat", "资料.md"] },
      },
    ]);
    snapshot.run.status = "running";
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(snapshot);
    const saved = await activityData.loadActivity(
      2,
      4,
      new AbortController().signal,
      () => {},
    );
    const data = { ...saved, complete: false };
    let publish!: (data: activityData.ActivityData) => void;
    const pending = deferred<activityData.ActivityData>();
    vi.spyOn(activityData, "loadActivity").mockImplementation(
      async (_agent, _sequence, _signal, callback) => {
        publish = callback;
        callback(data);
        return pending.promise;
      },
    );
    testing.render(
      view(
        [],
        false,
        false,
        <ConversationFeed agentId={2} runs={[run(4)]} loading={false} />,
      ),
    );
    const toggle = await testing.screen.findByRole("button", {
      name: "Read file 资料.md · Loading result",
    });
    const article = toggle.closest("article");
    testing.fireEvent.click(toggle);
    await testing.act(async () => publish({ ...data, complete: true }));
    expect(
      testing.screen.getByRole("button", {
        name: "Read file 资料.md · Waiting for result",
      }),
    ).toBe(toggle);
    await testing.act(async () => {
      const complete = { ...data, run: run(4), complete: true };
      publish(complete);
      pending.resolve(complete);
    });
    expect(
      testing.screen.getByRole("button", {
        name: "Read file 资料.md · No saved result",
      }),
    ).toBe(toggle);
    expect(toggle.closest("article")).toBe(article);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      testing.screen.queryByLabelText("Reading saved activity"),
    ).toBeNull();
  });

  it("updates disconnected loading entries and resumes their existing nodes", async () => {
    let disconnected = false;
    vi.spyOn(backend, "disconnected", "get").mockImplementation(
      () => disconnected,
    );
    const pending = deferred<activityData.ActivityData>();
    vi.spyOn(activityData, "loadActivity").mockImplementation(
      async () => pending.promise,
    );
    const initial = { ...run(4), reminded: undefined };
    const feed = (
      <ConversationFeed agentId={2} runs={[initial]} loading={false} />
    );
    const rendered = testing.render(view([], false, false, feed));
    const trigger = await testing.screen.findByLabelText("Loading reminder");
    const article = trigger.closest("article");
    expect(
      testing.screen.getByLabelText("Reading saved activity"),
    ).toBeTruthy();
    disconnected = true;
    await event({ type: "connection.closed" } as BackendEvent);
    expect(testing.screen.queryByLabelText("Loading reminder")).toBeNull();
    expect(
      testing.screen.queryByLabelText("Reading saved activity"),
    ).toBeNull();
    expect(testing.screen.getByRole("article", { name: "Reminder" })).toBe(
      article,
    );
    expect(testing.screen.queryByText("No saved reminder")).toBeNull();
    disconnected = false;
    await event({ type: "connection.restored" } as BackendEvent);
    expect(
      testing.screen.getByLabelText("Loading reminder").closest("article"),
    ).toBe(article);
    expect(
      testing.screen.getByLabelText("Reading saved activity"),
    ).toBeTruthy();
    rendered.unmount();
  });

  it("uses the current activity retry registration after the run changes", async () => {
    const load = vi
      .spyOn(activityData, "loadActivity")
      .mockRejectedValue(
        new BackendError("timeout", "Activity timed out", true),
      );
    const firstCache: WindowCache = {
      values: new Map(),
      following: true,
      position: null,
    };
    const nextCache: WindowCache = {
      values: new Map(),
      following: true,
      position: null,
    };
    const feed = (cache: WindowCache) => (
      <WindowContext.Provider value={cache}>
        <ConversationFeed
          agentId={2}
          runs={[{ ...run(4), request_count: 0, legacy: true }]}
          loading={false}
        />
      </WindowContext.Provider>
    );
    const rendered = testing.render(view([], false, false, feed(firstCache)));
    const retry = await testing.screen.findByRole("button", {
      name: "Retry activity",
    });
    const first = load.mock.calls[0][2];
    const previous = firstCache.values.get("conversation:reads");
    rendered.rerender(view([], false, false, feed(nextCache)));
    await testing.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(first.aborted).toBe(true);
    await testing.waitFor(() =>
      expect(retry.hasAttribute("disabled")).toBe(false),
    );
    const current = nextCache.values.get("conversation:reads");
    testing.fireEvent.click(retry);
    await testing.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(firstCache.values.get("conversation:reads")).toBe(previous);
    expect(nextCache.values.get("conversation:reads")).not.toBe(current);
    expect(load.mock.calls[2][2]).not.toBe(first);
    expect(load.mock.calls[2][2].aborted).toBe(false);
    expect(testing.screen.getByRole("button", { name: "Retry activity" })).toBe(
      retry,
    );
  });

  it("updates adjacent grouping and Member identity through the entry boundary", async () => {
    const first = { part_kind: "text", content: "第一段正文", timestamp: date };
    const second = {
      part_kind: "text",
      content: "第二段正文",
      timestamp: date,
    };
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(4, [first, second]),
    );
    const data = await activityData.loadActivity(
      2,
      4,
      new AbortController().signal,
      () => {},
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(4, [first, { ...second, timestamp: "2026-10-08T09:25:00Z" }]),
    );
    const updated = await activityData.loadActivity(
      2,
      4,
      new AbortController().signal,
      () => {},
    );
    let publish!: (data: activityData.ActivityData) => void;
    vi.spyOn(activityData, "loadActivity").mockImplementation(
      async (_agent, _sequence, _signal, callback) => {
        publish = callback;
        callback(data);
        return data;
      },
    );
    const feed = (
      <ConversationFeed agentId={2} runs={[run(4)]} loading={false} />
    );
    const rendered = testing.render(view([], false, false, feed));
    const body = await testing.screen.findByText("第二段正文");
    const article = body.closest("article");
    expect(article?.classList.contains("mt-1")).toBe(true);
    await testing.act(async () => publish(updated));
    expect(body.closest("article")).toBe(article);
    expect(article?.classList.contains("mt-4")).toBe(true);
    rendered.rerender(view([], false, false, feed, "资料助手"));
    expect(article?.textContent).toContain("资料助手");
    expect(article?.querySelector("svg rect")).toBeTruthy();
    expect(testing.screen.getByText("第二段正文")).toBe(body);
  });

  it("expands a long work record according to its measured content height", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.textContent === "较长的已保存正文" ? 600 : 100;
      },
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(4, [{ part_kind: "text", content: "较长的已保存正文" }]),
    );
    mount();
    const body = await testing.screen.findByText("较长的已保存正文");
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: "Show more" }),
    );
    expect(testing.screen.getByText("较长的已保存正文")).toBe(body);
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Show less" }),
    );
    expect(testing.screen.getByText("较长的已保存正文")).toBe(body);
  });

  it("preserves fully read source-unknown text with an explicit missing-source description", async () => {
    const value = withReminder(
      read(4, [{ part_kind: "text", content: "完成记录" }]),
      "来源未保存的原文",
    );
    if (!value.request) throw new Error("Saved request is missing");
    value.request.input.messages[0] = {
      kind: "request",
      parts: [{ part_kind: "user-prompt", content: "来源未保存的原文" }],
    };
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    mount();
    expect(await testing.screen.findByText("来源未保存的原文")).toBeTruthy();
    expect(
      await testing.screen.findByText(
        /The saved context source could not be confirmed/,
      ),
    ).toBeTruthy();
    expect(testing.screen.queryByText("No saved reminder")).toBeNull();
    expect(testing.screen.queryByText("Loading reminder")).toBeNull();
    expect(
      testing.screen.queryByRole("article", { name: "Reminder" }),
    ).toBeNull();
  });

  it("shows a fully read empty Reminder at the original activity start time", async () => {
    const value = withReminder(
      read(4, [{ part_kind: "text", content: "完成记录" }]),
      "",
    );
    value.run.reminded = [];
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    mount();
    expect(
      (await testing.screen.findByText("No saved reminder"))
        .closest("article")
        ?.querySelector("time")?.dateTime,
    ).toBe(date);
    expect(testing.screen.queryByText("Loading reminder")).toBeNull();
  });

  it("shows the complete saved Reminder at the activity start time without reading current discussion messages", async () => {
    const reminder =
      "You are 文档助手 (Member 2). These Messages mention you and are waiting for you:\n\n- [previously reminded] Discussion 8 (网站说明), Message 12 from 林小雨\n\nUse discussion action=read to see what they say and the surrounding context, then decide what to do.";
    const value = withReminder(
      read(4, [{ part_kind: "text", content: "完成记录" }]),
      reminder,
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    const source = vi.spyOn(backend, "discussionPage");
    const markRead = vi.spyOn(backend, "markRead");
    const ack = vi.spyOn(backend, "ack");
    mount();
    const body = await testing.screen.findByText(reminder, {
      selector: "pre",
      normalizer: (value) => value,
    });
    const bubble = body.closest("article");
    expect(bubble?.getAttribute("aria-label")).toBe("Reminder");
    expect(bubble?.querySelector("time")?.dateTime).toBe(date);
    expect(bubble?.querySelectorAll("svg rect")).toHaveLength(0);
    expect(bubble?.querySelectorAll("a")).toHaveLength(0);
    expect(source).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(await testing.screen.findByText("完成记录")).toBeTruthy();
  });
  it("keeps Markdown in the work record with the Agent identity", async () => {
    mount();
    const strong = await testing.screen.findByText("校验");
    expect(strong.getAttribute("data-streamdown")).toBe("strong");
    expect(strong.classList.contains("font-semibold")).toBe(true);
    const bubble = strong.closest("article");
    expect(bubble?.getAttribute("aria-label")).toBe("Agent work record");
    expect(bubble?.textContent).toContain("文档助手");
    expect(bubble?.querySelectorAll("svg rect").length).toBeGreaterThan(0);
  });
  it("shows a readable command target and reads parameters and formatted results only on expansion", async () => {
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      command(
        JSON.stringify({
          exit_code: 0,
          stdout: "发布步骤已经核对\n可以发送通知",
          stderr: "",
        }),
      ),
    );
    mount();
    const toggle = await testing.screen.findByRole("button", {
      name: "Read file docs/发布说明.md · Result saved",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      testing.screen.queryByText("/project/fora/docs/发布说明.md"),
    ).toBeNull();
    expect(
      testing.screen.queryByText("发布步骤已经核对", { exact: false }),
    ).toBeNull();
    testing.fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      await testing.screen.findByText("/project/fora/docs/发布说明.md", {
        selector: "pre",
      }),
    ).toBeTruthy();
    expect(
      await testing.screen.findByText("发布步骤已经核对", { exact: false }),
    ).toBeTruthy();
    expect(
      testing.screen.queryByText('{"exit_code":0', { exact: false }),
    ).toBeNull();
    testing.fireEvent.click(toggle);
    expect(
      testing.screen.queryByText("/project/fora/docs/发布说明.md"),
    ).toBeNull();
  });
  it.each(["not_found", "not_a_member"])(
    "keeps a %s history read failure in the Reminder and retries the same saved identity",
    async (code) => {
      const value = withReminder(
        read(4, [{ part_kind: "text", content: "恢复后的工作记录" }]),
        "本次提醒原文",
      );
      const source = vi
        .mocked(backend.agentHistoryRead)
        .mockRejectedValueOnce(new BackendError(code, "Unavailable"))
        .mockResolvedValue(value);
      const current = vi.spyOn(backend, "discussionPage");
      mount();
      const failure = await testing.screen.findByText("Unavailable");
      expect(failure.closest("article")?.querySelector("time")?.dateTime).toBe(
        date,
      );
      expect(testing.screen.queryByText("No saved reminder")).toBeNull();
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Retry reminder" }),
      );
      await testing.screen.findByText("本次提醒原文");
      await testing.screen.findByText("恢复后的工作记录");
      expect(source.mock.calls[1]).toEqual(source.mock.calls[0]);
      expect(current).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "preserves a successful saved send and its ending text when their complete content matches %s",
    async (same) => {
      const value = read(
        4,
        [
          {
            part_kind: "tool-call",
            tool_name: "discussion",
            tool_call_id: "send",
            args: { action: "send", discussion_id: 8, body: "通知已经发送" },
          },
        ],
        [
          {
            part_kind: "tool-return",
            tool_name: "discussion",
            tool_call_id: "send",
            content: { discussion_id: 8, id: 14, created_at: date },
          },
        ],
      );
      const next = read(4, [
        {
          part_kind: "text",
          content: same ? "通知已经发送" : "工作记录已经保存",
        },
      ]);
      if (!value.request || !next.request)
        throw new Error("Saved request is missing");
      const second = { ...next.requests[0], ordinal: 2 };
      value.run = { ...value.run, request_count: 2 };
      value.requests = [value.requests[0], second];
      next.run = value.run;
      next.requests = value.requests;
      next.request.summary = second;
      next.request.input = {
        ...empty,
        total: 2,
        messages: [
          ...(value.request.response?.messages ?? []),
          ...value.request.related.messages,
        ],
      };
      vi.mocked(backend.agentHistoryRead).mockImplementation(
        async (_agent, _sequence, ordinal) => (ordinal === 2 ? next : value),
      );
      const current = vi.spyOn(backend, "discussionPage");
      mount();
      expect(await testing.screen.findByText("通知已经发送")).toBeTruthy();
      await testing.waitFor(() =>
        expect(testing.screen.getByText("Sent to Discussion 8")).toBeTruthy(),
      );
      if (!same) await testing.screen.findByText("工作记录已经保存");
      expect(testing.screen.getAllByText("通知已经发送")).toHaveLength(1);
      expect(
        testing.screen.getAllByRole("button", { name: /Message details/ }),
      ).toHaveLength(1);
      expect(
        testing.screen.queryByRole("article", { name: "Agent work record" }) !==
          null,
      ).toBe(!same);
      expect(current).not.toHaveBeenCalled();
    },
  );
  it("distinguishes a history read failure from a fully read empty Reminder", async () => {
    vi.mocked(backend.agentHistoryRead)
      .mockRejectedValueOnce(
        new BackendError("timeout", "Reading timed out", true),
      )
      .mockResolvedValue(
        read(4, [{ part_kind: "text", content: "读取恢复完成" }]),
      );
    mount();
    await testing.screen.findByText("Reading timed out");
    const reminder = testing.screen
      .getByText("Reading timed out")
      .closest("article");
    expect(reminder?.querySelector("time")?.dateTime).toBe(date);
    expect(reminder?.querySelectorAll("svg rect")).toHaveLength(0);
    expect(testing.screen.queryByText("No saved reminder")).toBeNull();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry reminder" }),
    );
    await testing.screen.findByText("读取恢复完成");
    expect(
      (await testing.screen.findByText("No saved reminder")).closest("article"),
    ).toBe(reminder);
  });
  it("keeps the empty current window selected and exposes migrated records through the missing-window entry", async () => {
    vi.mocked(backend.agentHistoryWindows).mockResolvedValue({
      ...directory([3, 2, 1], 3),
      has_unassigned: true,
    });
    vi.mocked(backend.agentHistory).mockImplementation(
      async (_agent, _before, _limit, _after, _windowsLimit, options) =>
        page(
          options?.window_number ?? null,
          options?.window_number === 3
            ? []
            : [options?.window_number === null ? 9 : 4],
        ),
    );
    vi.mocked(backend.agentHistoryRead).mockImplementation(
      async (_agent, sequence) =>
        read(sequence, [
          { part_kind: "text", content: `保存记录 ${sequence}` },
        ]),
    );
    mount();
    const select = await testing.screen.findByRole("combobox", {
      name: "Context window",
    });
    expect((select as HTMLButtonElement).value).toBe("3");
    await testing.screen.findByText("No activity yet");
    await chooseWindow(select, "1");
    await testing.screen.findByText("保存记录 4");
    await chooseWindow(select, "unassigned");
    await testing.screen.findByText("保存记录 9");
    expect(testing.screen.queryByText("保存记录 4")).toBeNull();
  });
  it.each(["success", "failure"])(
    "discards a late %s from a window no longer selected",
    async (outcome) => {
      const pending = deferred<AgentHistoryPage>();
      vi.mocked(backend.agentHistoryWindows).mockResolvedValue(
        directory([2, 1], 2),
      );
      vi.mocked(backend.agentHistory).mockImplementation(
        async (_agent, _before, _limit, _after, _windowsLimit, options) =>
          options?.window_number === 2 ? pending.promise : page(1, [4]),
      );
      mount();
      const select = await testing.screen.findByRole("combobox", {
        name: "Context window",
      });
      await chooseWindow(select, "1");
      await testing.screen.findByText("校验");
      await testing.act(async () => {
        if (outcome === "success") pending.resolve(page(2, [8]));
        else pending.reject(new Error("Delayed window error"));
      });
      expect((select as HTMLButtonElement).value).toBe("1");
      expect(testing.screen.queryByText("Delayed window error")).toBeNull();
      expect(testing.screen.getByText("校验")).toBeTruthy();
    },
  );
  it("preserves each window's earlier pages and Unicode text cursor", async () => {
    vi.mocked(backend.agentHistoryWindows).mockResolvedValue(
      directory([2, 1], 2),
    );
    vi.mocked(backend.agentHistory).mockImplementation(
      async (_agent, before, _limit, _after, _windowsLimit, options) =>
        options?.window_number === 2
          ? page(2, [8])
          : before
            ? page(1, [3])
            : page(1, [4], true),
    );
    const text: HistoryText = {
      kind: "text",
      source: "response",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 0, "content"],
      value: "中文",
      offset: 0,
      next_offset: 6,
      total_bytes: 12,
      has_more: true,
    };
    vi.mocked(backend.agentHistoryRead).mockImplementation(
      async (_agent, sequence) =>
        read(sequence, [
          {
            part_kind: "text",
            content:
              sequence === 4
                ? (text as unknown as HistoryValue)
                : `记录 ${sequence}`,
          },
        ]),
    );
    const continuation = vi
      .spyOn(backend, "agentHistoryText")
      .mockResolvedValue({
        offset: 6,
        next_offset: 12,
        total_bytes: 12,
        value: "内容",
        has_more: false,
      });
    mount();
    const select = await testing.screen.findByRole("combobox", {
      name: "Context window",
    });
    await testing.screen.findByText("记录 8");
    await chooseWindow(select, "1");
    testing.fireEvent.click(
      await testing.screen.findByRole("button", {
        name: "Load earlier history",
      }),
    );
    await testing.screen.findByText("记录 3");
    testing.fireEvent.click(
      await testing.screen.findByRole("button", { name: "Load more text" }),
    );
    await testing.screen.findByText("中文内容");
    await chooseWindow(select, "2");
    await testing.screen.findByText("记录 8");
    await chooseWindow(select, "1");
    await testing.screen.findByText("中文内容");
    expect(testing.screen.getByText("记录 3")).toBeTruthy();
    expect(continuation.mock.calls[0][2].offset).toBe(6);
    expect(continuation).toHaveBeenCalledOnce();
  });
  it("shares the saved structured output read while its action is closed", async () => {
    const reference: HistoryText = {
      kind: "text",
      source: "related",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 0, "content"],
      offset: 0,
      next_offset: 10,
      total_bytes: 34,
      value: '{"stdout":',
      has_more: true,
    };
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      command(reference as unknown as HistoryValue),
    );
    const pending = deferred<{
      offset: number;
      next_offset: number;
      total_bytes: number;
      value: string;
      has_more: boolean;
    }>();
    const text = vi
      .spyOn(backend, "agentHistoryText")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        offset: 10,
        next_offset: 34,
        total_bytes: 34,
        value: '"结果","exit_code":0}',
        has_more: false,
      });
    mount();
    const toggle = await testing.screen.findByRole("button", {
      name: /Read file docs/,
    });
    testing.fireEvent.click(toggle);
    await testing.waitFor(() => expect(text).toHaveBeenCalledOnce());
    testing.fireEvent.click(toggle);
    await testing.act(async () =>
      pending.resolve({
        offset: 10,
        next_offset: 34,
        total_bytes: 34,
        value: '"结果","exit_code":0}',
        has_more: false,
      }),
    );
    testing.fireEvent.click(toggle);
    await testing.screen.findByText("结果");
    expect(text).toHaveBeenCalledOnce();
    expect(text.mock.calls[0][2].offset).toBe(10);
  });
  it("loads images within the expanded action and retries the original saved position", async () => {
    const binary = {
      kind: "binary",
      source: "related",
      request_ordinal: 1,
      message_index: 0,
      path: ["parts", 0, "content"],
      media_type: "image/png",
      size: 68,
      identifier: null,
    };
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(command(binary));
    const image = vi
      .spyOn(backend, "agentHistoryImage")
      .mockRejectedValueOnce(
        new BackendError("timeout", "Image timed out", true),
      )
      .mockResolvedValue({
        media_type: "image/png",
        data: "aW1hZ2U=",
        size: 68,
        identifier: null,
      });
    mount();
    const toggle = await testing.screen.findByRole("button", {
      name: /Read file docs/,
    });
    expect(image).not.toHaveBeenCalled();
    testing.fireEvent.click(toggle);
    await testing.screen.findByText("Image timed out");
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry image" }),
    );
    const opener = await testing.screen.findByRole("button", {
      name: "Open history image",
    });
    expect(image.mock.calls[0][2]).toEqual(binary);
    expect(image.mock.calls[1]).toEqual(image.mock.calls[0]);
    opener.focus();
    testing.fireEvent.click(opener);
    await testing.screen.findByRole("dialog", { name: "History image" });
    testing.fireEvent.click(
      testing.screen.getAllByRole("button", { name: "Close" })[0],
    );
    await testing.waitFor(() =>
      expect(testing.screen.queryByRole("dialog")).toBeNull(),
    );
    expect(document.activeElement).toBe(opener);
  });
  it("retries earlier history without replacing the saved message nodes", async () => {
    vi.mocked(backend.agentHistory)
      .mockResolvedValueOnce(page(1, [4], true))
      .mockRejectedValueOnce(
        new BackendError("timeout", "Earlier page failed", true),
      )
      .mockResolvedValue(page(1, [3]));
    vi.mocked(backend.agentHistoryRead).mockImplementation(
      async (_agent, sequence) =>
        read(sequence, [{ part_kind: "text", content: `内容 ${sequence}` }]),
    );
    mount();
    const body = await testing.screen.findByText("内容 4");
    const article = body.closest("article");
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load earlier history" }),
    );
    await testing.screen.findByText("Earlier page failed");
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry earlier history" }),
    );
    await testing.screen.findByText("内容 3");
    expect(testing.screen.getByText("内容 4").closest("article")).toBe(article);
    expect(
      testing.screen.queryByRole("button", { name: "Load earlier history" }),
    ).toBeNull();
  });
  it("recovers the selected window after disconnect and ignores the interrupted read", async () => {
    const pending = deferred<AgentHistoryRead>();
    vi.mocked(backend.agentHistoryRead)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(
        read(4, [{ part_kind: "text", content: "恢复后的正文" }]),
      );
    mount();
    await testing.waitFor(() =>
      expect(backend.agentHistoryRead).toHaveBeenCalledOnce(),
    );
    await event({ type: "connection.closed" });
    await event({ type: "connection.restored" });
    await testing.screen.findByText("恢复后的正文");
    await testing.act(async () =>
      pending.resolve(read(4, [{ part_kind: "text", content: "过期正文" }])),
    );
    expect(testing.screen.queryByText("过期正文")).toBeNull();
  });
  it.each([true, false])(
    "continues to the next current window only when following is %s",
    async (following) => {
      let current = 2;
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("conversation-scroll") ? 1500 : 100;
        },
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("conversation-scroll") ? 500 : 100;
        },
      );
      vi.mocked(backend.agentHistoryWindows).mockImplementation(async () =>
        directory(current === 2 ? [2, 1] : [3, 2, 1], current),
      );
      vi.mocked(backend.agentHistory).mockImplementation(
        async (_agent, _before, _limit, _after, _windowsLimit, options) =>
          page(options?.window_number ?? null, [
            Number(options?.window_number) * 4,
          ]),
      );
      vi.mocked(backend.agentHistoryRead).mockImplementation(
        async (_agent, sequence) =>
          read(sequence, [
            { part_kind: "text", content: `窗口正文 ${sequence}` },
          ]),
      );
      mount(true);
      const select = await testing.screen.findByRole("combobox", {
        name: "Context window",
      });
      await testing.screen.findByText("窗口正文 8");
      const scroll = testing.screen.getByTestId("scroll");
      scroll.scrollTop = following ? 1000 : 200;
      testing.fireEvent.scroll(scroll);
      current = 3;
      await event({
        type: "turn.completed",
        agent_id: 2,
        sequence: 12,
      } as BackendEvent);
      await testing.waitFor(() =>
        expect((select as HTMLButtonElement).value).toBe(following ? "3" : "2"),
      );
    },
  );
});
