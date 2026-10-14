import { type ReactNode, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Avatar } from "@/components/ui/index";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TreeView } from "@/features/library/tree-view";
import {
  AgentDetailStatus,
  HistorySection,
  LiveTools,
  MemberPage,
  TurnHistoryModal,
  WorkspaceContent,
  WorkspaceSection,
} from "@/features/members/detail";
import {
  type AgentDetail,
  type AgentHistoryRead,
  type AgentHistoryRequestSummary,
  type AgentRun,
  BackendError,
  backend,
  type HistoryBinary,
  type HistoryImage,
  type HistoryMessages,
  type HistoryText,
  type LibraryEntry,
  type LivePage,
} from "@/lib/backend";
import { formatTime } from "@/lib/format";

vi.mock("@/features/settings/model", () => ({
  AgentModelPanel: () => null,
}));

vi.mock("@/components/ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/dialog")>()),
  ConfirmDialog: vi.fn(() => null),
  Modal: ({
    children,
    footer,
    open,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    open: boolean;
  }) =>
    open ? (
      <div>
        {children}
        {footer}
      </div>
    ) : null,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const detail: AgentDetail = {
  id: 2,
  workspace: [],
  runs: [],
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    requests: 0,
    total_tokens: 0,
  },
  token_limit: 0,
  over_token_limit: false,
  idle: false,
  idle_streak: 0,
  no_tool_streak: 0,
  pause_reason: null,
  window: { number: 1, since_sequence: 0, reset_at: null, reason: null },
};
const entries: LibraryEntry[] = [
  {
    path: "notes",
    kind: "directory",
    size: 0,
    modified_at: "2026-01-01T00:00:00Z",
  },
  {
    path: "notes/MEMORY.md",
    kind: "file",
    size: 5,
    modified_at: "2026-01-01T00:00:00Z",
  },
];

function status(value: AgentDetail) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AgentDetailStatus detail={value} />
    </TooltipProvider>,
  );
}

describe("Agent deletion", () => {
  it("describes leaving Discussions and keeps the delete action", async () => {
    const refresh = vi.fn(async () => {});
    const remove = vi
      .spyOn(backend, "deleteAgent")
      .mockResolvedValue({ id: 2 });
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: [
                { id: 2, name: "Helper", type: "agent", state: "idle" },
              ],
              humanId: 1,
              connectionError: null,
              organizationError: null,
              discussionsError: null,
              retry: async () => {},
              discussions: [],
              refresh,
            }}
          >
            <MemberPage id={2} />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
    expect(html).toContain(
      renderToStaticMarkup(<Avatar memberId={2} size="lg" />),
    );
    const confirmation = vi.mocked(ConfirmDialog).mock.calls[0][0];
    expect(confirmation.title).toBe("Delete Helper?");
    expect(confirmation.description).toBe(
      "It leaves every Discussion and stops running.",
    );
    expect(confirmation.confirmLabel).toBe("Delete Agent");
    await confirmation.onConfirm();
    expect(remove).toHaveBeenCalledExactlyOnceWith(2);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Agent detail status", () => {
  it("shows pause intent while the current activity completes", () => {
    expect(
      status({ ...detail, state: "running", pause_requested: true }),
    ).toContain("Pause requested · Current activity will finish");
    expect(
      status({ ...detail, state: "paused", pause_requested: true }),
    ).not.toContain("Current activity will finish");
    expect(status(detail)).not.toContain("Pause requested");
  });
  it("uses the kernel idle flag even below the previous threshold", () => {
    expect(status({ ...detail, idle: true, idle_streak: 1 })).toContain(
      "Idle · 1",
    );
    expect(status({ ...detail, idle: false, idle_streak: 20 })).not.toContain(
      "Idle ·",
    );
    expect(status({ ...detail, idle: true, idle_streak: 1000 })).toContain(
      "Idle · 1,000",
    );
  });

  it("shows later windows but not the initial window", () => {
    expect(status(detail)).not.toContain("Window");
    const html = status({
      ...detail,
      window: {
        number: 1200,
        since_sequence: 10,
        reset_at: "2026-01-01T00:00:00Z",
        reason: "budget",
      },
    });
    expect(html).toContain("Window 1,200");
    expect(html).toContain("<button");
    expect(html).not.toContain("title=");
  });
});

describe("Agent history", () => {
  it("shows the complete Turn entry and request count", () => {
    const run: AgentRun = {
      sequence: 4,
      run_id: "run-4",
      status: "failed",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
      last_saved_at: "2026-01-01T00:00:30Z",
      window_number: 2,
      request_count: 2,
      usage: null,
      error: "Provider failed",
      effects: [],
    };
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HistorySection agentId={2} initialRuns={[run]} />
      </TooltipProvider>,
    );
    expect(html).toContain("History");
    expect(html).toContain("2 model requests");
    expect(html).toContain("View full context");
    expect(html).toContain("Provider failed");
  });
});

describe("Agent history request fields", () => {
  let act: typeof import("@testing-library/react").act;
  let cleanup: typeof import("@testing-library/react").cleanup;
  let fireEvent: typeof import("@testing-library/react").fireEvent;
  let render: typeof import("@testing-library/react").render;
  let screen: typeof import("@testing-library/react").screen;
  let within: typeof import("@testing-library/react").within;
  let waitFor: typeof import("@testing-library/react").waitFor;
  let closeDom: (() => void) | undefined;

  beforeAll(async () => {
    const packageName = "jsdom";
    const { JSDOM } = await import(packageName);
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost",
    });
    closeDom = () => dom.window.close();
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("navigator", dom.window.navigator);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
    vi.stubGlobal("Event", dom.window.Event);
    vi.stubGlobal("EventTarget", dom.window.EventTarget);
    vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
    vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
    vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
    vi.stubGlobal("AbortController", dom.window.AbortController);
    vi.stubGlobal("AbortSignal", dom.window.AbortSignal);
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
    dom.window.requestAnimationFrame = vi.fn();
    dom.window.cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", dom.window.requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame);
    const testing = await import("@testing-library/react");
    act = testing.act;
    cleanup = testing.cleanup;
    fireEvent = testing.fireEvent;
    render = testing.render;
    screen = testing.screen;
    within = testing.within;
    waitFor = testing.waitFor;
  }, 30000);

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("delegates reading history to the real window directory and conversation entry", async () => {
    vi.spyOn(backend, "disconnected", "get").mockReturnValue(false);
    const directory = vi
      .spyOn(backend, "agentHistoryWindows")
      .mockResolvedValue({
        agent_id: 2,
        current_window_number: 1,
        windows: [
          {
            number: 1,
            is_current: true,
            started_at: "2026-01-01T00:00:00Z",
            start_reason: null,
            ended_at: null,
            end_reason: null,
            since_sequence: 0,
          },
        ],
        has_unassigned: false,
        has_before: false,
        next_before: null,
      });
    const history = vi.spyOn(backend, "agentHistory").mockResolvedValue({
      agent_id: 2,
      window_number: 1,
      runs: [],
      windows: [],
      has_before: false,
      next_before: null,
      windows_has_more: false,
      windows_next_after: null,
    });
    const subscriptions = new Set<Parameters<typeof backend.onEvent>[0]>();
    vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    });
    const mounted = render(
      <TooltipProvider>
        <OrganizationProvider
          value={{
            members: [{ id: 2, name: "Alpha", type: "agent", state: "idle" }],
            humanId: 1,
            discussions: [],
            connectionError: null,
            organizationError: null,
            discussionsError: null,
            retry: async () => {},
            refresh: async () => {},
          }}
        >
          <HistorySection agentId={2} initialRuns={[]} reading />
        </OrganizationProvider>
      </TooltipProvider>,
    );
    expect(await screen.findByText("Initial context")).toBeTruthy();
    expect(await screen.findByText("No activity yet")).toBeTruthy();
    expect(directory).toHaveBeenCalledExactlyOnceWith(2);
    expect(history).toHaveBeenCalledExactlyOnceWith(
      2,
      undefined,
      30,
      undefined,
      30,
      { window_number: 1 },
    );
    expect(subscriptions.size).toBe(2);
    mounted.unmount();
    expect(subscriptions.size).toBe(0);
  });

  afterAll(() => {
    closeDom?.();
    vi.unstubAllGlobals();
  });

  function page(id: number, strict = false) {
    const content = (
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: [
                { id: 2, name: "Alpha", type: "agent", state: "idle" },
                { id: 3, name: "Beta", type: "agent", state: "idle" },
              ],
              humanId: 1,
              discussions: [],
              connectionError: null,
              organizationError: null,
              discussionsError: null,
              retry: async () => {},
              refresh: async () => {},
            }}
          >
            <MemberPage id={id} />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>
    );
    return strict ? <StrictMode>{content}</StrictMode> : content;
  }

  function pendingDetail() {
    let resolve!: (value: AgentDetail) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<AgentDetail>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  function events() {
    vi.spyOn(backend, "disconnected", "get").mockReturnValue(false);
    vi.spyOn(backend, "agentHistoryWindows").mockImplementation(
      () => new Promise(() => {}),
    );
    const listeners = new Set<Parameters<typeof backend.onEvent>[0]>();
    const stops = vi.fn();
    vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        stops();
      };
    });
    return {
      listeners,
      stops,
      emit: (event: Parameters<Parameters<typeof backend.onEvent>[0]>[0]) => {
        for (const listener of listeners) listener(event);
      },
    };
  }

  function tokens(value: number, id = 2): AgentDetail {
    return {
      ...detail,
      id,
      usage: { ...detail.usage, total_tokens: value },
    };
  }

  async function openContext() {
    fireEvent.click(screen.getByRole("button", { name: "Inspect context" }));
    await act(async () => {});
  }

  function livePage(revision: number, finished = false): LivePage {
    return {
      runtime_epoch: "epoch",
      turn: {
        agent_id: 2,
        sequence: 4,
        run_id: "run-4",
        live_revision: revision,
        status: "running",
        error: null,
        requests: [
          {
            ordinal: 1,
            request_id: "request-1",
            started_at: "2026-01-01T00:00:00Z",
            tools_has_more: false,
            tools_next_after: null,
            tools: [
              {
                part_index: 0,
                tool_call_id: "short",
                tool_name: "short",
                status: finished ? "completed" : "running",
                started_at: null,
                completed_at: null,
                saved: false,
                has_result: finished,
                content_version: "tool-v1",
              },
              {
                part_index: 1,
                tool_call_id: "long",
                tool_name: "long",
                status: "running",
                started_at: null,
                completed_at: null,
                saved: false,
                has_result: false,
              },
            ],
          },
        ],
        has_more: false,
        next_after: null,
      },
    };
  }

  it("shows the completed short tool result while the long tool continues", async () => {
    const updates = events();
    vi.spyOn(backend, "agentLive")
      .mockResolvedValueOnce(livePage(1))
      .mockResolvedValue(livePage(2, true));
    vi.spyOn(backend, "agentLiveRead").mockResolvedValue({
      messages: [{ content: "short result" }],
      offset: 0,
      total: 1,
      has_more: false,
    });
    const view = render(<LiveTools agentId={2} sequence={4} ordinal={1} />);
    await waitFor(() => expect(view.container.textContent).toContain("short"));
    updates.emit({
      type: "tool.updated",
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      part_index: 0,
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain("short result"),
    );
    expect(view.container.textContent).toContain("completed");
    expect(view.container.textContent).toContain("longrunning");
    expect(backend.agentLiveRead).toHaveBeenCalledWith(
      2,
      4,
      1,
      0,
      "epoch",
      "tool",
      "tool-v1",
    );
  });

  it("marks the failed response as Not saved and releases it after confirmed persistence", async () => {
    const updates = events();
    const page = livePage(1);
    const failedTurn = page.turn;
    if (!failedTurn) throw new Error("Expected a live Turn");
    failedTurn.status = "unsaved";
    failedTurn.requests[0] = {
      ...failedTurn.requests[0],
      tools: [],
      has_response: true,
      response_saved: false,
      response_version: "response-v1",
    };
    vi.spyOn(backend, "agentLive")
      .mockResolvedValueOnce(page)
      .mockResolvedValue({ runtime_epoch: "epoch", turn: null });
    let finish!: (value: HistoryMessages) => void;
    vi.spyOn(backend, "agentLiveRead").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<LiveTools agentId={2} sequence={4} ordinal={1} />);
    await waitFor(() =>
      expect(view.container.textContent).toContain("Not saved"),
    );
    await waitFor(() =>
      expect(backend.agentLiveRead).toHaveBeenCalledWith(
        2,
        4,
        1,
        0,
        "epoch",
        "response",
        "response-v1",
      ),
    );
    updates.emit({ type: "turn.finished", agent_id: 2, sequence: 4 });
    await waitFor(() => expect(view.container.textContent).toBe(""));
    finish({
      messages: [{ content: "unsaved response" }],
      offset: 0,
      total: 1,
      has_more: false,
    });
    await Promise.resolve();
    expect(view.container.textContent).toBe("");
  });

  it("publishes only content at the confirmed saved revision", async () => {
    const updates = events();
    let finish!: (value: LivePage) => void;
    const saved = livePage(3, true);
    const savedTurn = saved.turn;
    if (!savedTurn) throw new Error("Expected a live Turn");
    savedTurn.requests[0].tools[0] = {
      ...savedTurn.requests[0].tools[0],
      saved: true,
      has_result: false,
    };
    vi.spyOn(backend, "agentLive")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(saved);
    const read = vi.spyOn(backend, "agentLiveRead");
    const view = render(<LiveTools agentId={2} sequence={4} ordinal={1} />);
    await waitFor(() => expect(backend.agentLive).toHaveBeenCalledTimes(1));
    updates.emit({
      type: "tool.updated",
      agent_id: 2,
      sequence: 4,
      ordinal: 1,
      runtime_epoch: "epoch",
      live_revision: 3,
      saved: true,
    });
    finish(livePage(1, true));
    await waitFor(() =>
      expect(view.container.textContent).toContain("completed"),
    );
    expect(backend.agentLive).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll(".text-danger")).toHaveLength(1);
  });

  it("combines tool notifications and publishes the pending snapshot before the next read", async () => {
    const updates = events();
    let finish!: (value: LivePage) => void;
    let finishNext!: (value: LivePage) => void;
    vi.spyOn(backend, "agentLive")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNext = resolve;
          }),
      );
    vi.spyOn(backend, "agentLiveRead").mockResolvedValue({
      messages: [{ content: "short result" }],
      offset: 0,
      total: 1,
      has_more: false,
    });
    const view = render(<LiveTools agentId={2} sequence={4} ordinal={1} />);
    await waitFor(() => expect(backend.agentLive).toHaveBeenCalledTimes(1));
    updates.emit({ type: "tool.updated", agent_id: 3, sequence: 4 });
    for (let index = 0; index < 100; index += 1)
      updates.emit({
        type: "tool.updated",
        agent_id: 2,
        sequence: 4,
        ordinal: 1,
      });
    expect(backend.agentLive).toHaveBeenCalledTimes(1);
    finish(livePage(1));
    await waitFor(() =>
      expect(view.container.textContent).toContain("longrunning"),
    );
    expect(backend.agentLive).toHaveBeenCalledTimes(2);
    finishNext(livePage(2, true));
    await waitFor(() =>
      expect(view.container.textContent).toContain("short result"),
    );
    expect(backend.agentLive).toHaveBeenCalledTimes(2);
  });

  it("clears temporary tool content when a different runtime epoch is read", async () => {
    const updates = events();
    vi.spyOn(backend, "agentLive")
      .mockResolvedValueOnce(livePage(1, true))
      .mockResolvedValue({ runtime_epoch: "new-epoch", turn: null });
    let finish!: (value: {
      messages: { content: string }[];
      offset: number;
      total: number;
      has_more: boolean;
    }) => void;
    vi.spyOn(backend, "agentLiveRead").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<LiveTools agentId={2} sequence={4} ordinal={1} />);
    await waitFor(() => expect(backend.agentLiveRead).toHaveBeenCalledTimes(1));
    updates.emit({ type: "connection.closed" });
    updates.emit({ type: "connection.restored" });
    await waitFor(() => expect(view.container.textContent).toBe(""));
    finish({
      messages: [{ content: "old result" }],
      offset: 0,
      total: 1,
      has_more: false,
    });
    await Promise.resolve();
    expect(view.container.textContent).toBe("");
  });

  it("batches quick Agent reads without extending the first event deadline", async () => {
    const stream = events();
    const read = vi.spyOn(backend, "agentDetail").mockResolvedValue(tokens(1));
    const view = render(page(2));
    await act(async () => {});
    await openContext();
    vi.useFakeTimers();
    for (let index = 1; index <= 20; index += 1) {
      read.mockResolvedValue(tokens(index));
      await act(async () => {
        stream.emit({ type: "usage.updated", agent_id: 2 });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(read).toHaveBeenCalledTimes(1 + Math.floor((index * 50) / 150));
      if (index % 3 === 0) expect(screen.getByText(String(index))).toBeTruthy();
    }
    await act(async () => stream.emit({ type: "turn.finished", agent_id: 2 }));
    expect(read).toHaveBeenCalledTimes(8);
    expect(screen.getByText("20")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(read).toHaveBeenCalledTimes(8);
    await act(async () => stream.emit({ type: "usage.updated", agent_id: 2 }));
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(read).toHaveBeenCalledTimes(8);
    expect(stream.listeners.size).toBe(0);
  });

  it("clears scheduled Agent reads on disconnect and identity change", async () => {
    const stream = events();
    const read = vi.spyOn(backend, "agentDetail").mockResolvedValue(tokens(1));
    const view = render(page(2));
    await act(async () => {});
    vi.useFakeTimers();
    await act(async () => {
      stream.emit({ type: "usage.updated", agent_id: 2 });
      stream.emit({ type: "connection.closed" });
      stream.emit({ type: "usage.updated", agent_id: 2 });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => stream.emit({ type: "connection.restored" }));
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => stream.emit({ type: "usage.updated", agent_id: 2 }));
    await act(async () => view.rerender(page(3)));
    expect(read.mock.calls.map(([id]) => id)).toEqual([2, 2, 3]);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(read.mock.calls.map(([id]) => id)).toEqual([2, 2, 3]);
  });

  it("batches the open Workspace file and reads Turn completion immediately", async () => {
    const stream = events();
    const read = vi.spyOn(backend, "workspaceRead").mockResolvedValue({
      path: "notes/MEMORY.md",
      content: "version 0",
      hash: "hash-0",
    });
    const view = render(
      <TooltipProvider>
        <WorkspaceSection agentId={2} entries={entries} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /notes/ }));
    fireEvent.click(screen.getByRole("button", { name: "MEMORY.md" }));
    await act(async () => {});
    expect(read).toHaveBeenCalledExactlyOnceWith(2, "notes/MEMORY.md");
    vi.useFakeTimers();
    for (let index = 1; index <= 20; index += 1) {
      read.mockResolvedValue({
        path: "notes/MEMORY.md",
        content: `version ${index}`,
        hash: `hash-${index}`,
      });
      await act(async () => {
        stream.emit({ type: "workspace.changed", agent_id: 3 });
        stream.emit({
          type: "workspace.changed",
          agent_id: 2,
          path: "other.md",
        });
        stream.emit({ type: "workspace.changed", agent_id: 2 });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(read).toHaveBeenCalledTimes(1 + Math.floor((index * 50) / 150));
      if (index % 3 === 0)
        expect(screen.getByText(`version ${index}`)).toBeTruthy();
    }
    await act(async () => stream.emit({ type: "turn.finished", agent_id: 2 }));
    expect(read).toHaveBeenCalledTimes(8);
    expect(screen.getByText("version 20")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(read).toHaveBeenCalledTimes(8);
    await act(async () =>
      stream.emit({ type: "workspace.changed", agent_id: 2 }),
    );
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(read).toHaveBeenCalledTimes(8);
    expect(stream.listeners.size).toBe(0);
  });

  it("combines Workspace events during a read and clears its disconnect batch", async () => {
    const stream = events();
    let finish!: (
      value: Awaited<ReturnType<typeof backend.workspaceRead>>,
    ) => void;
    let finishNext!: (
      value: Awaited<ReturnType<typeof backend.workspaceRead>>,
    ) => void;
    const read = vi
      .spyOn(backend, "workspaceRead")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNext = resolve;
          }),
      )
      .mockResolvedValue({
        path: "notes/MEMORY.md",
        content: "restored",
        hash: "restored",
      });
    render(
      <TooltipProvider>
        <WorkspaceSection agentId={2} entries={entries} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /notes/ }));
    fireEvent.click(screen.getByRole("button", { name: "MEMORY.md" }));
    await act(async () => {});
    await act(async () => {
      for (let index = 0; index < 20; index += 1)
        stream.emit({ type: "workspace.changed", agent_id: 2 });
      finish({ path: "notes/MEMORY.md", content: "first", hash: "first" });
    });
    expect(screen.getByText("first")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () =>
      finishNext({
        path: "notes/MEMORY.md",
        content: "second",
        hash: "second",
      }),
    );
    expect(screen.getByText("second")).toBeTruthy();
    vi.useFakeTimers();
    await act(async () => {
      stream.emit({ type: "workspace.changed", agent_id: 2 });
      stream.emit({ type: "connection.closed" });
      stream.emit({ type: "workspace.changed", agent_id: 2 });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => stream.emit({ type: "connection.restored" }));
    expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getByText("restored")).toBeTruthy();
  });

  it("filters unrelated events and merges bursts while publishing every completed read", async () => {
    const stream = events();
    const first = pendingDetail();
    const second = pendingDetail();
    const third = pendingDetail();
    const read = vi
      .spyOn(backend, "agentDetail")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    render(page(2));
    await act(async () => {});
    expect(read).toHaveBeenCalledExactlyOnceWith(2);
    await act(async () => {
      for (let index = 0; index < 20; index += 1)
        stream.emit({ type: "turn.progress", agent_id: 3 });
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (let index = 0; index < 20; index += 1)
        stream.emit({ type: "turn.progress", agent_id: 2 });
      stream.emit({ type: "settings.updated" });
      stream.emit({ type: "organization.changed" });
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(tokens(101)));
    await openContext();
    expect(screen.getByText("101")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (let index = 0; index < 20; index += 1)
        stream.emit({ type: "turn.progress", agent_id: 2 });
      second.resolve(tokens(202));
    });
    expect(screen.getByText("202")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(3);
    const finalRun: AgentRun = {
      sequence: 4,
      run_id: "run-4",
      status: "failed",
      started_at: "2026-10-06T13:00:00Z",
      completed_at: "2026-10-06T13:02:00Z",
      last_saved_at: "2026-10-06T13:01:59Z",
      usage: null,
      error: "Final Turn error",
      effects: [],
    };
    await act(async () => third.resolve({ ...tokens(303), runs: [finalRun] }));
    expect(screen.getByText("303")).toBeTruthy();
    expect(screen.getAllByText("Final Turn error").length).toBeGreaterThan(0);
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(
      screen.getByText(`Saved ${formatTime(finalRun.last_saved_at as string)}`),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `Finished ${formatTime(finalRun.completed_at as string)}`,
      ),
    ).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => stream.emit({ type: "turn.completed", agent_id: 3 }));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "isolates late results after switching Agent (failure=%s)",
    async (failure) => {
      const stream = events();
      const old = pendingDetail();
      const current = pendingDetail();
      const read = vi
        .spyOn(backend, "agentDetail")
        .mockResolvedValueOnce(tokens(101))
        .mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(() => current.promise);
      const view = render(page(2));
      await act(async () => {});
      await openContext();
      expect(screen.getByText("101")).toBeTruthy();
      await act(async () =>
        stream.emit({ type: "turn.progress", agent_id: 2 }),
      );
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      view.rerender(page(3));
      await act(async () => {});
      expect(screen.queryByText("101")).toBeNull();
      expect(read.mock.calls.map(([id]) => id)).toEqual([2, 2, 3]);
      await act(async () => {
        if (failure) old.reject(new Error("stale Agent failure"));
        else old.resolve(tokens(999));
        current.resolve(tokens(303, 3));
      });
      await openContext();
      expect(screen.getByText("303")).toBeTruthy();
      expect(screen.queryByText("999")).toBeNull();
      expect(screen.queryByText("stale Agent failure")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(stream.listeners.size).toBe(2);
      view.unmount();
      expect(stream.listeners.size).toBe(0);
    },
  );

  it("recovers an initial failure through Retry and displays empty history", async () => {
    events();
    const read = vi
      .spyOn(backend, "agentDetail")
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockResolvedValueOnce(tokens(101));
    render(page(2));
    await act(async () => {});
    expect(screen.queryByText("No activity yet")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("initial failure");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry" })),
    );
    expect(read).toHaveBeenCalledTimes(2);
    await openContext();
    expect(screen.getByText("101")).toBeTruthy();
    expect(screen.getAllByText("No activity yet").length).toBeGreaterThan(0);
  });

  it("retains content on failure and merges Retry through the same refresh lifecycle", async () => {
    const stream = events();
    const recovery = pendingDetail();
    const read = vi
      .spyOn(backend, "agentDetail")
      .mockResolvedValueOnce(tokens(101))
      .mockRejectedValueOnce(new Error("read failed"))
      .mockImplementationOnce(() => recovery.promise)
      .mockResolvedValueOnce(tokens(303));
    render(page(2));
    await act(async () => {});
    await openContext();
    await act(async () => stream.emit({ type: "turn.failed", agent_id: 2 }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByText("101")).toBeTruthy();
    expect(screen.getAllByRole("alert")[0].textContent).toContain(
      "read failed",
    );
    const retry = screen.getAllByRole("button", { name: "Retry" })[0];
    await act(async () => {
      fireEvent.click(retry);
      fireEvent.click(retry);
      stream.emit({ type: "turn.progress", agent_id: 2 });
    });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => recovery.resolve(tokens(202)));
    expect(screen.getByText("303")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])(
    "isolates the old connection during reconnect (failure=%s)",
    async (failure) => {
      const stream = events();
      const old = pendingDetail();
      const current = pendingDetail();
      const followup = pendingDetail();
      const read = vi
        .spyOn(backend, "agentDetail")
        .mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(() => current.promise)
        .mockImplementationOnce(() => followup.promise);
      render(page(2));
      await act(async () => {});
      await act(async () => {
        stream.emit({ type: "connection.closed" });
        stream.emit({ type: "turn.progress", agent_id: 2 });
      });
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () => stream.emit({ type: "connection.restored" }));
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => {
        stream.emit({ type: "turn.progress", agent_id: 2 });
        if (failure) old.reject(new Error("old connection failure"));
        else old.resolve(tokens(999));
      });
      expect(read).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("999")).toBeNull();
      expect(screen.queryByText("old connection failure")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => current.resolve(tokens(202)));
      await openContext();
      expect(screen.getByText("202")).toBeTruthy();
      expect(read).toHaveBeenCalledTimes(3);
      await act(async () => followup.resolve(tokens(303)));
      expect(screen.getByText("303")).toBeTruthy();
    },
  );

  it.each([false, true])(
    "cleans StrictMode subscriptions and ignores completion after unmount (failure=%s)",
    async (failure) => {
      const stream = events();
      const pending = pendingDetail();
      const read = vi
        .spyOn(backend, "agentDetail")
        .mockImplementation(() => pending.promise);
      const view = render(page(2, true));
      await act(async () => {});
      expect(read).toHaveBeenCalledExactlyOnceWith(2);
      expect(stream.listeners.size).toBe(1);
      view.unmount();
      expect(stream.listeners.size).toBe(0);
      expect(stream.stops).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (failure) pending.reject(new Error("unmounted failure"));
        else pending.resolve(tokens(999));
      });
      expect(screen.queryByText("unmounted failure")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an explicitly located request through Retry and inline latest updates", async () => {
    const read = vi
      .spyOn(backend, "agentHistoryRead")
      .mockRejectedValue(
        new BackendError("not_found", "Saved request not found"),
      );
    const modal = (initialOrdinal: number, latestOrdinal: number) => (
      <TooltipProvider>
        <TurnHistoryModal
          agentId={2}
          sequence={4}
          initialOrdinal={initialOrdinal}
          latestOrdinal={latestOrdinal}
          open
          inline
          onOpenChange={() => {}}
        />
      </TooltipProvider>
    );
    const view = render(modal(2, 5));
    await act(async () => {});
    expect(read.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [2, 4, 2],
    ]);
    view.rerender(modal(2, 9));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry" })),
    );
    expect(read.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [2, 4, 2],
      [2, 4, 2],
    ]);
    view.rerender(modal(3, 9));
    await act(async () => {});
    expect(read.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [2, 4, 2],
      [2, 4, 2],
      [2, 4, 3],
    ]);
  });

  it("resets long request fields before continuing the selected request", async () => {
    const summary = (ordinal: number): AgentHistoryRequestSummary => ({
      ordinal,
      request_id: `request-${ordinal}`,
      run_id: "run-4",
      window_number: 2,
      status: "completed",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
      streaming: false,
      input_length: 0,
      parameters_length: 10,
      settings_length: 10,
      model_length: 10,
      response_length: 0,
      input_count: 0,
      response_count: 0,
      related_count: 0,
      error: null,
    });
    const field = (
      source: HistoryText["source"],
      ordinal: number,
      value: string,
      hasMore: boolean,
    ): HistoryText => ({
      kind: "text",
      source,
      request_ordinal: ordinal,
      message_index: 0,
      path: ["value"],
      offset: 0,
      next_offset: value.length,
      total_bytes: value.length + (hasMore ? 5 : 0),
      value,
      has_more: hasMore,
    });
    const emptyMessages = {
      messages: [],
      offset: 0,
      total: 0,
      has_more: false,
    };
    const read = (ordinal: number): AgentHistoryRead => ({
      agent_id: 2,
      run: {
        sequence: 4,
        run_id: "run-4",
        status: "failed",
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:01:00Z",
        last_saved_at: "2026-01-01T00:00:30Z",
        window_number: 2,
        window_reset_at: null,
        window_reason: null,
        request_count: 2,
        usage: null,
        error: null,
        legacy: false,
      },
      windows: [],
      windows_has_more: false,
      windows_next_after: null,
      requests: [summary(1), summary(2)],
      requests_has_more: false,
      requests_next_after: null,
      messages: emptyMessages,
      missing: [],
      request: {
        summary: summary(ordinal),
        input: emptyMessages,
        parameters: field(
          "parameters",
          ordinal,
          `request-${ordinal}-parameters`,
          true,
        ),
        settings: field(
          "settings",
          ordinal,
          `request-${ordinal}-settings`,
          false,
        ),
        model: field("model", ordinal, `request-${ordinal}-model`, false),
        response: null,
        related: emptyMessages,
      },
    });
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(
      async (_agentId, _sequence, ordinal) => read(ordinal ?? 1),
    );
    const textRead = vi
      .spyOn(backend, "agentHistoryText")
      .mockImplementation(async (_agentId, _sequence, reference) => ({
        offset: reference.offset,
        next_offset: reference.offset + 5,
        total_bytes: reference.offset + 5,
        value: `request-${reference.request_ordinal}-tail`,
        has_more: false,
      }));

    render(
      <TooltipProvider>
        <HistorySection
          agentId={2}
          initialRuns={[
            {
              sequence: 4,
              run_id: "run-4",
              status: "failed",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: "2026-01-01T00:01:00Z",
              last_saved_at: "2026-01-01T00:00:30Z",
              window_number: 2,
              request_count: 2,
              usage: null,
              error: null,
              effects: [],
            },
          ]}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View full context" }));
    expect(await screen.findByText("request-1-parameters")).toBeTruthy();

    const parametersPanel = () => {
      const heading = screen.getByRole("heading", {
        name: "Model request parameters",
      });
      const section = heading.closest("section");
      if (!(section instanceof HTMLElement))
        throw new Error("Request parameters section is missing");
      return within(section);
    };

    fireEvent.click(
      parametersPanel().getByRole("button", { name: "Load more text" }),
    );
    expect(await screen.findByText(/request-1-tail/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Request 2/ }));
    expect(await screen.findByText("request-2-parameters")).toBeTruthy();
    expect(await screen.findByText("request-2-settings")).toBeTruthy();
    expect(await screen.findByText("request-2-model")).toBeTruthy();
    expect(screen.queryByText(/request-1-tail/)).toBeNull();
    expect(screen.queryByText("request-1-parameters")).toBeNull();
    expect(screen.queryByText("request-1-settings")).toBeNull();
    expect(screen.queryByText("request-1-model")).toBeNull();

    fireEvent.click(
      parametersPanel().getByRole("button", { name: "Load more text" }),
    );
    expect(await screen.findByText(/request-2-tail/)).toBeTruthy();
    expect(screen.queryByText(/request-1-tail/)).toBeNull();
    expect(textRead).toHaveBeenLastCalledWith(
      2,
      4,
      expect.objectContaining({
        request_ordinal: 2,
        offset: expect.any(Number),
      }),
    );
  });

  it("resets long responses and images when changing requests", async () => {
    const summary = (ordinal: number): AgentHistoryRequestSummary => ({
      ordinal,
      request_id: `request-${ordinal}`,
      run_id: "run-4",
      window_number: 2,
      status: "completed",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z",
      streaming: false,
      input_length: 0,
      parameters_length: 10,
      settings_length: 10,
      model_length: 10,
      response_length: 20,
      input_count: 0,
      response_count: 2,
      related_count: 0,
      error: null,
    });
    const field = (
      source: HistoryText["source"],
      ordinal: number,
      value: string,
      hasMore: boolean,
    ): HistoryText => ({
      kind: "text",
      source,
      request_ordinal: ordinal,
      message_index: 0,
      path: ["value"],
      offset: 0,
      next_offset: value.length,
      total_bytes: value.length + (hasMore ? 5 : 0),
      value,
      has_more: hasMore,
    });
    const image = (ordinal: number): HistoryBinary => ({
      kind: "binary",
      source: "response",
      request_ordinal: ordinal,
      message_index: 1,
      path: ["image"],
      media_type: "image/png",
      size: 3,
      identifier: `image-${ordinal}`,
    });
    const emptyMessages = {
      messages: [],
      offset: 0,
      total: 0,
      has_more: false,
    };
    const read = (ordinal: number): AgentHistoryRead => ({
      agent_id: 2,
      run: {
        sequence: 4,
        run_id: "run-4",
        status: "failed",
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:01:00Z",
        last_saved_at: "2026-01-01T00:00:30Z",
        window_number: 2,
        window_reset_at: null,
        window_reason: null,
        request_count: 2,
        usage: null,
        error: null,
        legacy: false,
      },
      windows: [],
      windows_has_more: false,
      windows_next_after: null,
      requests: [summary(1), summary(2)],
      requests_has_more: false,
      requests_next_after: null,
      messages: emptyMessages,
      missing: [],
      request: {
        summary: summary(ordinal),
        input: emptyMessages,
        parameters: field(
          "parameters",
          ordinal,
          `request-${ordinal}-parameters`,
          false,
        ),
        settings: field(
          "settings",
          ordinal,
          `request-${ordinal}-settings`,
          false,
        ),
        model: field("model", ordinal, `request-${ordinal}-model`, false),
        response: {
          messages: [
            field("response", ordinal, `request-${ordinal}-response`, true),
            image(ordinal),
          ],
          offset: 0,
          total: 2,
          has_more: false,
        },
        related: emptyMessages,
      },
    });
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(
      async (_agentId, _sequence, ordinal) => read(ordinal ?? 1),
    );
    const textRead = vi
      .spyOn(backend, "agentHistoryText")
      .mockImplementation(async (_agentId, _sequence, reference) => ({
        offset: reference.offset,
        next_offset: reference.offset + 5,
        total_bytes: reference.offset + 5,
        value: `request-${reference.request_ordinal}-response-tail`,
        has_more: false,
      }));
    let resolveSecondImage!: (value: HistoryImage) => void;
    const secondImage = new Promise<HistoryImage>((resolve) => {
      resolveSecondImage = resolve;
    });
    vi.spyOn(backend, "agentHistoryImage").mockImplementation(
      async (_agentId, _sequence, reference) => {
        if (reference.request_ordinal === 2) return secondImage;
        return {
          media_type: "image/png",
          size: 3,
          identifier: "image-1",
          data: "image-one",
        };
      },
    );

    render(
      <TooltipProvider>
        <HistorySection
          agentId={2}
          initialRuns={[
            {
              sequence: 4,
              run_id: "run-4",
              status: "failed",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: "2026-01-01T00:01:00Z",
              last_saved_at: "2026-01-01T00:00:30Z",
              window_number: 2,
              request_count: 2,
              usage: null,
              error: null,
              effects: [],
            },
          ]}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View full context" }));
    expect(await screen.findByText("request-1-response")).toBeTruthy();
    expect(await screen.findByAltText("Saved model content")).toBeTruthy();

    const responsePanel = () => {
      const heading = screen.getByRole("heading", { name: "Model response" });
      const section = heading.closest("section");
      if (!(section instanceof HTMLElement))
        throw new Error("Model response section is missing");
      return within(section);
    };

    fireEvent.click(
      responsePanel().getByRole("button", { name: "Load more text" }),
    );
    expect(await screen.findByText(/request-1-response-tail/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Request 2/ }));
    expect(await screen.findByText("request-2-response")).toBeTruthy();
    expect(screen.queryByText(/request-1-response-tail/)).toBeNull();
    expect(screen.queryByAltText("Saved model content")).toBeNull();
    expect(screen.getByText(/Loading image/)).toBeTruthy();

    resolveSecondImage({
      media_type: "image/png",
      size: 3,
      identifier: "image-2",
      data: "image-two",
    });
    const nextImage = await screen.findByAltText("Saved model content");
    expect(nextImage.getAttribute("src")).toBe(
      "data:image/png;base64,image-two",
    );

    fireEvent.click(
      responsePanel().getByRole("button", { name: "Load more text" }),
    );
    expect(await screen.findByText(/request-2-response-tail/)).toBeTruthy();
    expect(screen.queryByText(/request-1-response-tail/)).toBeNull();
    expect(textRead).toHaveBeenLastCalledWith(
      2,
      4,
      expect.objectContaining({
        source: "response",
        request_ordinal: 2,
        offset: expect.any(Number),
      }),
    );
  });

  it("combines Turn progress while the initial history read is running", async () => {
    const emptyMessages = {
      messages: [],
      offset: 0,
      total: 0,
      has_more: false,
    };
    const summary: AgentHistoryRequestSummary = {
      ordinal: 1,
      request_id: "request-1",
      run_id: "run-4",
      window_number: 1,
      status: "pending",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: null,
      streaming: false,
      input_length: 0,
      parameters_length: 2,
      settings_length: 2,
      model_length: 2,
      response_length: 0,
      input_count: 0,
      response_count: 0,
      related_count: 0,
      error: null,
    };
    const field = (source: HistoryText["source"]): HistoryText => ({
      kind: "text",
      source,
      request_ordinal: 1,
      message_index: 0,
      path: [],
      offset: 0,
      next_offset: 2,
      total_bytes: 2,
      value: "{}",
      has_more: false,
    });
    const run = {
      sequence: 4,
      run_id: "run-4",
      status: "running",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: null,
      last_saved_at: "2026-01-01T00:00:01Z",
      window_number: 1,
      window_reset_at: null,
      window_reason: null,
      request_count: 1,
      usage: null,
      error: null,
      legacy: false,
    };
    const initialRead: AgentHistoryRead = {
      agent_id: 2,
      run: { ...run, request_count: 0, legacy: true },
      windows: [],
      windows_has_more: false,
      windows_next_after: null,
      requests: [],
      requests_has_more: false,
      requests_next_after: null,
      messages: emptyMessages,
      missing: [],
    };
    const liveRead: AgentHistoryRead = {
      agent_id: 2,
      run,
      windows: [],
      windows_has_more: false,
      windows_next_after: null,
      requests: [summary],
      requests_has_more: false,
      requests_next_after: null,
      messages: emptyMessages,
      missing: [],
      request: {
        summary,
        input: emptyMessages,
        parameters: field("parameters"),
        settings: field("settings"),
        model: field("model"),
        response: null,
        related: emptyMessages,
      },
    };
    let resolveInitial!: (value: AgentHistoryRead) => void;
    const initial = new Promise<AgentHistoryRead>((resolve) => {
      resolveInitial = resolve;
    });
    let reads = 0;
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? initial : liveRead;
    });
    let listener: Parameters<typeof backend.onEvent>[0] | undefined;
    vi.spyOn(backend, "onEvent").mockImplementation((next) => {
      listener = next;
      return vi.fn();
    });

    render(
      <TooltipProvider>
        <HistorySection
          agentId={2}
          initialRuns={[
            {
              sequence: 4,
              run_id: "run-4",
              status: "running",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: null,
              last_saved_at: "2026-01-01T00:00:01Z",
              window_number: 1,
              request_count: 1,
              usage: null,
              error: null,
              effects: [],
            },
          ]}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /#4/ }));
    fireEvent.click(screen.getByRole("button", { name: "View full context" }));
    await waitFor(() => expect(reads).toBe(1));
    listener?.({ type: "turn.progress", agent_id: 2, sequence: 4 });
    expect(reads).toBe(1);
    resolveInitial(initialRead);
    expect(await screen.findByRole("tab", { name: /Request 1/ })).toBeTruthy();
    expect(reads).toBe(2);
  });

  it("keeps the restored request when the previous connection read fails later", async () => {
    const emptyMessages = {
      messages: [],
      offset: 0,
      total: 0,
      has_more: false,
    };
    const summary: AgentHistoryRequestSummary = {
      ordinal: 1,
      request_id: "request-1",
      run_id: "run-4",
      window_number: 1,
      status: "pending",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: null,
      streaming: false,
      input_length: 0,
      parameters_length: 2,
      settings_length: 2,
      model_length: 2,
      response_length: 0,
      input_count: 0,
      response_count: 0,
      related_count: 0,
      error: null,
    };
    const field = (source: HistoryText["source"]): HistoryText => ({
      kind: "text",
      source,
      request_ordinal: 1,
      message_index: 0,
      path: [],
      offset: 0,
      next_offset: 2,
      total_bytes: 2,
      value: "{}",
      has_more: false,
    });
    const run = {
      sequence: 4,
      run_id: "run-4",
      status: "running",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: null,
      last_saved_at: "2026-01-01T00:00:01Z",
      window_number: 1,
      window_reset_at: null,
      window_reason: null,
      request_count: 1,
      usage: null,
      error: null,
      legacy: false,
    };
    const liveRead: AgentHistoryRead = {
      agent_id: 2,
      run,
      windows: [],
      windows_has_more: false,
      windows_next_after: null,
      requests: [summary],
      requests_has_more: false,
      requests_next_after: null,
      messages: emptyMessages,
      missing: [],
      request: {
        summary,
        input: emptyMessages,
        parameters: field("parameters"),
        settings: field("settings"),
        model: field("model"),
        response: null,
        related: emptyMessages,
      },
    };
    let rejectInitial!: (reason?: unknown) => void;
    const initial = new Promise<AgentHistoryRead>((_, reject) => {
      rejectInitial = reject;
    });
    let reads = 0;
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? initial : liveRead;
    });
    let listener: Parameters<typeof backend.onEvent>[0] | undefined;
    vi.spyOn(backend, "onEvent").mockImplementation((next) => {
      listener = next;
      return vi.fn();
    });

    render(
      <TooltipProvider>
        <HistorySection
          agentId={2}
          initialRuns={[
            {
              sequence: 4,
              run_id: "run-4",
              status: "running",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: null,
              last_saved_at: "2026-01-01T00:00:01Z",
              window_number: 1,
              request_count: 1,
              usage: null,
              error: null,
              effects: [],
            },
          ]}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /#4/ }));
    fireEvent.click(screen.getByRole("button", { name: "View full context" }));
    await waitFor(() => expect(reads).toBe(1));
    listener?.({ type: "connection.closed" });
    listener?.({ type: "connection.restored" });
    expect(await screen.findByRole("tab", { name: /Request 1/ })).toBeTruthy();

    rejectInitial(new Error("stale initial failure"));
    await Promise.resolve();
    expect(screen.getByRole("tab", { name: /Request 1/ })).toBeTruthy();
    expect(screen.queryByText("stale initial failure")).toBeNull();
  });

  it("ignores a history failure after the modal closes", async () => {
    let rejectRead!: (reason?: unknown) => void;
    const pending = new Promise<AgentHistoryRead>((_, reject) => {
      rejectRead = reject;
    });
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(
      async () => pending,
    );

    render(
      <TooltipProvider>
        <HistorySection
          agentId={2}
          initialRuns={[
            {
              sequence: 4,
              run_id: "run-4",
              status: "running",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: null,
              last_saved_at: "2026-01-01T00:00:01Z",
              window_number: 1,
              request_count: 0,
              usage: null,
              error: null,
              effects: [],
            },
          ]}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /#4/ }));
    fireEvent.click(screen.getByRole("button", { name: "View full context" }));
    expect(await screen.findByText("Loading activity history")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Loading activity history")).toBeNull();

    rejectRead(new Error("closed history failure"));
    await Promise.resolve();
    expect(screen.queryByText("closed history failure")).toBeNull();
  });
});

describe("Workspace tree", () => {
  it("uses the shared tree with collapsed folders and file counts", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <WorkspaceSection agentId={2} entries={entries} />
      </TooltipProvider>,
    );
    expect(html).toMatch(/<h2\b[^>]*>Workspace<\/h2>/);
    expect(html).toContain('aria-label="Workspace files"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("notes");
    expect(html).toContain(">1</p>");
    expect(html).not.toContain("MEMORY.md");
    expect(html).not.toContain("Actions");
  });

  it("opens files without hashes in read-only mode and suppresses all actions", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <TreeView
          entries={[...entries, { ...entries[1], path: "notes/.image.png" }]}
          expanded={new Set(["notes"])}
          onToggle={() => {}}
          onOpen={() => {}}
          readOnly
          rowActions={() => [
            { id: "delete", label: "Delete", onSelect: () => {} },
          ]}
        />
      </TooltipProvider>,
    );
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.join("")).toContain(">MEMORY.md<");
    expect(buttons.join("")).toContain(">.image.png<");
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("Delete");
    expect(html).not.toContain("Actions");
  });

  it("preserves the empty Workspace state", () => {
    expect(
      renderToStaticMarkup(<WorkspaceSection agentId={2} entries={[]} />),
    ).toContain("No Workspace files");
  });

  it("renders escaped, read-only content and its UTF-8 byte size without actions", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContent
        file={{ path: "notes/MEMORY.md", content: "<中文>\n", hash: "hash" }}
      />,
    );
    expect(html).toContain("9 B");
    expect(html).toContain("&lt;中文&gt;\n</pre>");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("button");
    expect(html).not.toContain("contenteditable");
  });
});
