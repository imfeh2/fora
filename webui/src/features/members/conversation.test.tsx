import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OrganizationProvider } from "@/app/organization";
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
  type Message,
} from "@/lib/backend";

let testing: typeof import("@testing-library/react");
let userEvent: typeof import("@testing-library/user-event").default;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let HistorySection: typeof import("@/features/members/detail").HistorySection;
let closeDom: () => void;
const listeners = new Set<(event: BackendEvent) => void>();
const observers = new Map<Element, () => void>();

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  closeDom = () => dom.window.close();
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "HTMLButtonElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "getComputedStyle",
  ])
    vi.stubGlobal(name, name === "window" ? dom.window : dom.window[name]);
  vi.stubGlobal(
    "requestAnimationFrame",
    dom.window.requestAnimationFrame.bind(dom.window),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    dom.window.cancelAnimationFrame.bind(dom.window),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      target: Element | null = null;
      constructor(readonly callback: () => void) {}
      observe(target: Element) {
        this.target = target;
        observers.set(target, this.callback);
      }
      disconnect() {
        if (this.target) observers.delete(this.target);
      }
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  testing = await import("@testing-library/react");
  userEvent = (await import("@testing-library/user-event")).default;
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
  ({ HistorySection } = await import("@/features/members/detail"));
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});
afterEach(() => {
  testing.cleanup();
  listeners.clear();
  observers.clear();
  vi.restoreAllMocks();
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function view(runs: AgentRun[] = [], scroll = false, controls = false) {
  return (
    <TooltipProvider>
      <OrganizationProvider
        value={{
          members: [{ id: 2, name: "文档助手", type: "agent", state: "idle" }],
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
          <HistorySection agentId={2} initialRuns={runs} reading />
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

describe("Member conversation", () => {
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

  it("orders successful replies by the saved message time and preserves their nodes as bodies arrive", async () => {
    const pending =
      deferred<Awaited<ReturnType<typeof backend.discussionPage>>>();
    const calls = [14, 15].map((id) => ({
      part_kind: "tool-call",
      tool_name: "discussion",
      tool_call_id: `send-${id}`,
      args: { action: "send", discussion_id: 8 },
    }));
    const receipts = [15, 14].map((id) => ({
      part_kind: "tool-return",
      tool_name: "discussion",
      tool_call_id: `send-${id}`,
      content: { discussion_id: 8, id, created_at: date },
    }));
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(
      read(4, calls, receipts),
    );
    vi.spyOn(backend, "discussionPage").mockImplementation(
      async (_id, options) =>
        options?.after === 13
          ? pending.promise
          : ({
              id: 8,
              messages: [
                {
                  ...message(15, 2, "较早发送的回复"),
                  created_at: "2026-10-08T09:16:00Z",
                },
              ],
            } as never),
    );
    mount();
    const earlier = await testing.screen.findByText("较早发送的回复");
    const node = earlier.closest("article");
    await testing.act(async () =>
      pending.resolve({
        id: 8,
        messages: [
          {
            ...message(14, 2, "随后发送的回复"),
            created_at: "2026-10-08T09:17:00Z",
          },
        ],
      } as never),
    );
    await testing.screen.findByText("随后发送的回复");
    const replies = testing.screen.getAllByRole("article", {
      name: "Agent message",
    });
    expect(replies.map((reply) => reply.textContent)).toEqual([
      expect.stringContaining("较早发送的回复"),
      expect.stringContaining("随后发送的回复"),
    ]);
    expect(earlier.closest("article")).toBe(node);
    expect(
      replies.map((reply) => reply.querySelector("time")?.dateTime),
    ).toEqual(["2026-10-08T09:16:00Z", "2026-10-08T09:17:00Z"]);
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

  it("keeps a saved trigger while reconnecting and ignores its interrupted response", async () => {
    const value = read(4, [{ part_kind: "text", content: "工作记录" }]);
    value.run.reminded = [{ discussion_id: 8, message_id: 12 }];
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    const pending =
      deferred<Awaited<ReturnType<typeof backend.discussionPage>>>();
    const source = vi
      .spyOn(backend, "discussionPage")
      .mockResolvedValueOnce({ id: 8, messages: [message(12)] } as never)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ id: 8, messages: [message(12)] } as never);
    mount();
    const body = await testing.screen.findByText("请查看发布说明");
    const node = body.closest("article");
    await event({ type: "connection.closed" });
    await event({ type: "connection.restored" });
    await testing.waitFor(() => expect(source).toHaveBeenCalledTimes(2));
    await event({ type: "connection.closed" });
    expect(testing.screen.getByText("请查看发布说明").closest("article")).toBe(
      node,
    );
    await event({ type: "connection.restored" });
    await testing.waitFor(() => expect(source).toHaveBeenCalledTimes(3));
    await testing.act(async () =>
      pending.resolve({
        id: 8,
        messages: [message(12, 1, "过期来源正文")],
      } as never),
    );
    expect(testing.screen.getByText("请查看发布说明").closest("article")).toBe(
      node,
    );
    expect(testing.screen.queryByText("过期来源正文")).toBeNull();
    expect(source.mock.calls[2]).toEqual(source.mock.calls[0]);
  });

  it("presents command details with readable paths and the saved output", async () => {
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
      await testing.screen.findByText("python -c \"print('命令执行完成')\""),
    ).toBeTruthy();
    expect(await testing.screen.findByText("命令执行完成")).toBeTruthy();
    expect(await testing.screen.findByText("Exited with code 0")).toBeTruthy();
    const details = toggle.closest("article");
    expect(details?.textContent).not.toContain("/project/");
    expect(details?.textContent).not.toContain(".venv");
    expect(details?.textContent).not.toContain("cwd");
    expect(details?.textContent).not.toContain("argv 1");
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
      expect(frame?.contains(testing.screen.getByText("Output"))).toBe(false);
      expect(
        frame?.contains(testing.screen.getByText("Exited with code 0")),
      ).toBe(false);
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
      name: /Failed/,
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
    expect(testing.screen.getByText("Exited with code 1")).toBeTruthy();
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
    const body = testing.screen.getByText(`printf ${argv[1]}`, {
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
    {
      argv: ["python", "-c", "print('library/core/example')"],
      displayed: "python -c \"print('library/core/example')\"",
    },
    {
      argv: ["printf", "%s", "category/tmp/example"],
      displayed: 'printf "%s" category/tmp/example',
    },
    {
      argv: ["curl", "https://example.com/library/core/tmp/example"],
      displayed: "curl https://example.com/library/core/tmp/example",
    },
    {
      argv: ["cat", "/project/fora/library/社区网站/交接记录.md"],
      displayed: "cat library/社区网站/交接记录.md",
    },
  ])("preserves argument semantics for $argv", async ({ argv, displayed }) => {
    const value = command({ exit_code: 0, stdout: "读取完成" }, { argv });
    const original = JSON.stringify(value);
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    mount();
    const toggle = await testing.screen.findByRole("button", {
      name: /Result saved/,
    });
    testing.fireEvent.click(toggle);
    expect(await testing.screen.findByText(displayed)).toBeTruthy();
    expect(await testing.screen.findByText("读取完成")).toBeTruthy();
    expect(JSON.stringify(value)).toBe(original);
  });

  it.each([
    "print('/tmp/example')",
    "print('/project/fora/library/core/example')",
    "print('core/.venv/bin/python')",
  ])(
    "shows an explicit command summary for resource-bearing code %s",
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
      await testing.screen.findByText("Command summary");
      expect(
        await testing.screen.findByText("Run python", { selector: "pre" }),
      ).toBeTruthy();
      expect(
        testing.screen.getByText(
          "Open Inspect context for the complete command and arguments.",
        ),
      ).toBeTruthy();
      expect(testing.screen.queryByText(code, { exact: false })).toBeNull();
      expect(
        await testing.screen.findByText("Exited with code 2"),
      ).toBeTruthy();
      expect(await testing.screen.findByText("无法读取文件")).toBeTruthy();
      expect(
        await testing.screen.findByRole("button", {
          name: "Run python · Failed",
        }),
      ).toBeTruthy();
      expect(JSON.stringify(value)).toContain(
        JSON.stringify(code).slice(1, -1),
      );
    },
  );

  it("shows file changes and message attachments without resource paths", async () => {
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
    await testing.screen.findByText("File updated");
    expect(edit.closest("article")?.textContent).not.toContain("/project/");
    testing.fireEvent.click(
      await testing.screen.findByRole("button", {
        name: "Read Discussion 8 · Result saved",
      }),
    );
    await testing.screen.findByText("请查看配图");
    expect(await testing.screen.findByText("发布页面.png")).toBeTruthy();
    expect(testing.screen.getByRole("feed").textContent).not.toContain(
      "/project/",
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

  it("reports the saved command failure after reading its structured output", async () => {
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
        name: "Read file docs/发布说明.md · Failed",
      }),
    ).toBeTruthy();
    expect(await testing.screen.findByText("文件尚未保存")).toBeTruthy();
  });

  it.each([0, 5, 30])(
    "joins every saved history interval when a %i-record summary refreshes during an earlier read",
    async (summaryCount) => {
      const pending = deferred<AgentHistoryPage>();
      let refreshed = false;
      const sequences = (upper: number, count: number) =>
        Array.from({ length: count }, (_, index) => upper - index);
      vi.mocked(backend.agentHistory).mockImplementation(
        async (_agent, before) => {
          if (before === 16) return pending.promise;
          if (before === 51) return page(1, sequences(50, 30), true);
          return page(1, sequences(refreshed ? 80 : 45, 30), true);
        },
      );
      vi.mocked(backend.agentHistoryRead).mockImplementation(
        async (_agent, sequence) =>
          read(sequence, [
            { part_kind: "text", content: `记录正文 ${sequence}` },
          ]),
      );
      const mounted = mount();
      await testing.screen.findByText("记录正文 45");
      const opener = testing.screen.getByText("Load earlier history", {
        selector: "button",
      });
      const controls = opener.parentElement;
      if (!controls) throw new Error("History controls are missing");
      const earlier = () => {
        const button = testing.within(controls).getByRole("button", {
          name: "Load earlier history",
        });
        expect(button.isConnected).toBe(true);
        return button;
      };
      testing.fireEvent.click(earlier());
      refreshed = true;
      mounted.rerender(
        view(
          sequences(80, summaryCount).map((sequence) => ({
            ...run(sequence),
            effects: [],
          })),
        ),
      );
      await testing.screen.findByText("记录正文 80");
      await testing.act(async () =>
        pending.resolve(page(1, sequences(15, 15))),
      );
      await testing.screen.findByText("记录正文 1");
      await testing.act(async () => testing.fireEvent.click(earlier()));
      await testing.screen.findByText("记录正文 50");
      expect(testing.screen.getByText("记录正文 45")).toBeTruthy();
      expect(testing.screen.getByText("记录正文 1")).toBeTruthy();
      expect(controls.isConnected).toBe(false);
      expect(
        testing.screen.queryByText("Load earlier history", {
          selector: "button",
        }),
      ).toBeNull();
    },
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
    const resize = root ? observers.get(root) : undefined;
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
    vi.spyOn(backend, "discussionPage").mockResolvedValue({
      id: 8,
      messages: [
        {
          ...message(12),
          sender_id: 77,
          sender_name: "陈沐",
          attachments: [attachment],
        },
      ],
    } as never);
    const file = vi
      .spyOn(backend, "attachmentFile")
      .mockRejectedValueOnce(new Error("Attachment interrupted"))
      .mockResolvedValue(
        new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:community-image");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const mounted = mount();
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
    vi.spyOn(backend, "discussionPage").mockResolvedValue({
      id: 8,
      messages: [{ ...message(12), attachments: [attachment] }],
    } as never);
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
      args: { action: "send", discussion_id: 8 },
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

  it("reads sender identity and the actual message time without a read or ack mutation", async () => {
    const value = read(4, [{ part_kind: "text", content: "完成记录" }]);
    value.run.reminded = [
      { discussion_id: 8, message_id: 12 },
      { discussion_id: 8, message_id: 12 },
    ];
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    const source = vi.spyOn(backend, "discussionPage").mockResolvedValue({
      id: 8,
      messages: [message(12)],
      metadata: { topic: "秋季发布" },
    } as never);
    const markRead = vi.spyOn(backend, "markRead");
    const ack = vi.spyOn(backend, "ack");
    mount();
    const body = await testing.screen.findByText("请查看发布说明");
    const bubble = body.closest("article");
    expect(bubble?.getAttribute("aria-label")).toBe("Trigger message");
    expect(bubble?.querySelector("time")?.dateTime).toBe(
      "2026-10-07T18:00:00Z",
    );
    expect(bubble?.textContent).toContain("林小雨");
    expect(bubble?.querySelectorAll("svg rect").length).toBeGreaterThan(0);
    expect(source.mock.calls).toEqual([
      [8, { after: 11, before: 13, limit: 1, metadata: true }],
    ]);
    expect(markRead).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(await testing.screen.findByText("完成记录")).toBeTruthy();
  });
  it("keeps Markdown in the work record with the Agent identity", async () => {
    mount();
    const strong = await testing.screen.findByText("校验");
    expect(strong.tagName).toBe("STRONG");
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
      await testing.screen.findByText("cat docs/发布说明.md"),
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
  it.each([
    ["not_found", "Trigger message not found"],
    ["not_a_member", "Access denied to trigger message"],
  ])(
    "keeps %s local and retries the saved trigger identity",
    async (code, label) => {
      const value = read(4, [{ part_kind: "text", content: "仍可阅读的记录" }]);
      value.run.reminded = [{ discussion_id: 8, message_id: 12 }];
      vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
      const source = vi
        .spyOn(backend, "discussionPage")
        .mockRejectedValueOnce(new BackendError(code, "Unavailable"))
        .mockResolvedValue({ id: 8, messages: [message(12)] } as never);
      mount();
      const failure = await testing.screen.findByText(label);
      expect(failure.closest("article")?.querySelector("time")?.dateTime).toBe(
        date,
      );
      expect(await testing.screen.findByText("仍可阅读的记录")).toBeTruthy();
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Retry message" }),
      );
      await testing.screen.findByText("请查看发布说明");
      expect(source.mock.calls[1]).toEqual(source.mock.calls[0]);
    },
  );
  it("uses successful send identities once and keeps model ending text in inspection", async () => {
    const value = read(
      4,
      [
        {
          part_kind: "tool-call",
          tool_name: "discussion",
          tool_call_id: "send",
          args: { action: "send", discussion_id: 8 },
        },
      ],
      [
        {
          part_kind: "tool-return",
          tool_name: "discussion",
          tool_call_id: "send",
          content: { discussion_id: 8, id: 14, created_at: date },
        },
        {
          part_kind: "tool-return",
          tool_name: "discussion",
          tool_call_id: "send",
          content: { discussion_id: 8, id: 14, created_at: date },
        },
      ],
    );
    vi.mocked(backend.agentHistoryRead).mockResolvedValue(value);
    vi.spyOn(backend, "discussionPage").mockResolvedValue({
      id: 8,
      messages: [message(14, 2, "通知已发送")],
      metadata: { topic: "秋季发布" },
    } as never);
    mount();
    expect(await testing.screen.findByText("通知已发送")).toBeTruthy();
    expect(testing.screen.getAllByText("通知已发送")).toHaveLength(1);
    expect(testing.screen.getByText("Sent to 秋季发布")).toBeTruthy();
    expect(
      testing.screen.queryByRole("button", { name: /Send to/ }),
    ).toBeNull();
    expect(
      testing.screen.queryByRole("article", { name: "Agent work record" }),
    ).toBeNull();
  });
  it("retries an activity read while preserving the conversation and uses real empty-trigger state", async () => {
    vi.mocked(backend.agentHistoryRead)
      .mockRejectedValueOnce(
        new BackendError("timeout", "Reading timed out", true),
      )
      .mockResolvedValue(
        read(4, [{ part_kind: "text", content: "读取恢复完成" }]),
      );
    mount();
    await testing.screen.findByText("Reading timed out");
    const trigger = testing.screen
      .getByText("No saved trigger information")
      .closest("article");
    expect(trigger?.querySelector("time")?.dateTime).toBe(date);
    expect(trigger?.querySelectorAll("svg rect")).toHaveLength(0);
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry activity" }),
    );
    await testing.screen.findByText("读取恢复完成");
    expect(
      testing.screen
        .getByText("No saved trigger information")
        .closest("article"),
    ).toBe(trigger);
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
  it("keeps a structured output continuation when its action is closed", async () => {
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
        value: '"迟到","exit_code":0}',
        has_more: false,
      }),
    );
    testing.fireEvent.click(toggle);
    await testing.screen.findByText("结果");
    expect(testing.screen.queryByText("迟到")).toBeNull();
    expect(text.mock.calls[1][2].offset).toBe(10);
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
