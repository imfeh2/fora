import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowHistoryState } from "@/features/members/history-state";
import { useConversationHistory } from "@/features/members/use-conversation-history";
import {
  type WindowCache,
  WindowContext,
} from "@/features/members/window-cache";
import {
  type AgentHistoryPage,
  type AgentHistoryRun,
  type AgentRun,
  BackendError,
  type BackendEvent,
  backend,
} from "@/lib/backend";

const listeners = new Set<(event: BackendEvent) => void>();
let disconnected = false;
const date = "2026-10-08T09:15:00Z";

function run(
  sequence: number,
  windowNumber: number | null = 1,
): AgentHistoryRun {
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

function page(
  sequences: number[],
  more = false,
  windowNumber: number | null = 1,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function cache(history?: WindowHistoryState): WindowCache {
  return {
    values: new Map(history ? [["history", history]] : []),
    following: true,
    position: null,
  };
}

function mount(saved = cache(), isCurrent = true) {
  const beforeOlder = vi.fn();
  const props = {
    agentId: 2,
    windowNumber: 1,
    isCurrent,
    initialRuns: [] as AgentRun[],
    beforeOlder,
  };
  const hook = renderHook((value) => useConversationHistory(value), {
    initialProps: props,
    wrapper: ({ children }: { children: ReactNode }) => (
      <WindowContext.Provider value={saved}>{children}</WindowContext.Provider>
    ),
  });
  return { ...hook, saved, beforeOlder, props };
}

async function emit(event: BackendEvent) {
  await act(async () => {
    if (event.type === "connection.closed") disconnected = true;
    if (event.type === "connection.restored") disconnected = false;
    for (const listener of [...listeners]) listener(event);
  });
}

async function finish(
  pending: ReturnType<typeof deferred<AgentHistoryPage>>,
  value: AgentHistoryPage,
) {
  await act(async () => pending.resolve(value));
}

beforeEach(() => {
  disconnected = false;
  vi.spyOn(backend, "disconnected", "get").mockImplementation(
    () => disconnected,
  );
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  vi.spyOn(backend, "agentHistory").mockResolvedValue(page([45, 16], true));
});

afterEach(() => {
  cleanup();
  expect(listeners.size).toBe(0);
  expect(document.body.childElementCount).toBe(0);
  vi.restoreAllMocks();
});

describe("useConversationHistory", () => {
  it("merges repeated refresh intentions into one subsequent latest read", async () => {
    const first = deferred<AgentHistoryPage>();
    const second = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistory)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const hook = mount();
    await emit({ type: "turn.started", agent_id: 2 });
    await emit({ type: "turn.completed", agent_id: 2 });
    await act(async () => hook.result.current.loadLatest());
    expect(backend.agentHistory).toHaveBeenCalledTimes(1);
    await finish(first, page([45, 16], true));
    expect(backend.agentHistory).toHaveBeenCalledTimes(2);
    expect(hook.result.current.latestLoading).toBe(true);
    await finish(second, page([80, 51], true));
    expect(backend.agentHistory).toHaveBeenCalledTimes(2);
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([80, 51, 45, 16]);
    expect(hook.result.current.latestLoading).toBe(false);
    expect(hook.result.current.latestError).toBeNull();
  });

  it.each(["latest", "older"])("merges %s first", async (order) => {
    const hook = mount();
    await act(async () => {});
    const latest = deferred<AgentHistoryPage>();
    const older = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistory).mockImplementation((_id, before) =>
      before === undefined ? latest.promise : older.promise,
    );
    await act(async () => {
      void hook.result.current.loadOlder();
      void hook.result.current.loadOlder();
      void hook.result.current.loadLatest();
    });
    expect(hook.beforeOlder).toHaveBeenCalledTimes(1);
    expect(backend.agentHistory).toHaveBeenCalledTimes(3);
    expect(vi.mocked(backend.agentHistory).mock.calls[1]).toEqual([
      2,
      16,
      30,
      undefined,
      30,
      { window_number: 1 },
    ]);
    if (order === "latest") {
      await finish(latest, page([80, 51], true));
      await finish(older, page([15, 1]));
    } else {
      await finish(older, page([15, 1]));
      await finish(latest, page([80, 51], true));
    }
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([80, 51, 45, 16, 15, 1]);
    expect(hook.result.current.history.ranges).toEqual([
      { upper: 80, lower: 51 },
      { upper: 45, lower: Number.NEGATIVE_INFINITY },
    ]);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(hook.result.current.olderLoading).toBe(false);
    expect(hook.result.current.latestLoading).toBe(false);
    expect(hook.saved.values.get("history:interrupted")).toBeNull();
  });

  it("retries the retained earlier cursor after a latest refresh", async () => {
    const hook = mount();
    await act(async () => {});
    const failure = new BackendError("request_failed", "Earlier unavailable");
    vi.mocked(backend.agentHistory).mockRejectedValueOnce(failure);
    await act(async () => hook.result.current.loadOlder());
    expect(hook.result.current.olderError).toBe(failure);
    expect(hook.saved.values.get("history:interrupted")).toBe(16);
    vi.mocked(backend.agentHistory).mockResolvedValueOnce(page([80, 51], true));
    await act(async () => hook.result.current.loadLatest());
    expect(hook.result.current.olderError).toBe(failure);
    vi.mocked(backend.agentHistory).mockResolvedValueOnce(page([15, 1]));
    await act(async () => hook.result.current.loadOlder());
    expect(vi.mocked(backend.agentHistory).mock.calls[3][1]).toBe(16);
    expect(hook.beforeOlder).toHaveBeenCalledTimes(2);
    expect(hook.result.current.olderError).toBeNull();
    expect(hook.saved.values.get("history:interrupted")).toBeNull();
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([80, 51, 45, 16, 15, 1]);
  });

  it.each(["success", "failure"])("ignores old %s", async (outcome) => {
    const hook = mount();
    await act(async () => {});
    const oldLatest = deferred<AgentHistoryPage>();
    const oldOlder = deferred<AgentHistoryPage>();
    const latest = deferred<AgentHistoryPage>();
    const older = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistory)
      .mockReturnValueOnce(oldOlder.promise)
      .mockReturnValueOnce(oldLatest.promise)
      .mockReturnValueOnce(latest.promise)
      .mockReturnValueOnce(older.promise);
    await act(async () => {
      void hook.result.current.loadOlder();
      void hook.result.current.loadLatest();
    });
    await emit({ type: "connection.closed" });
    expect(hook.result.current.latestLoading).toBe(false);
    expect(hook.result.current.olderLoading).toBe(false);
    expect(hook.saved.values.get("history:interrupted")).toBe(16);
    await act(async () => {
      await hook.result.current.loadLatest();
      await hook.result.current.loadOlder();
    });
    expect(backend.agentHistory).toHaveBeenCalledTimes(3);
    await emit({ type: "connection.restored" });
    expect(backend.agentHistory).toHaveBeenCalledTimes(5);
    expect(vi.mocked(backend.agentHistory).mock.calls[4][1]).toBe(16);
    await act(async () => {
      if (outcome === "success") {
        oldLatest.resolve({ ...page([99]), agent_id: 9 });
        oldOlder.resolve({ ...page([98]), agent_id: 9 });
      } else {
        oldLatest.reject(new Error("Old latest"));
        oldOlder.reject(new Error("Old older"));
      }
    });
    expect(hook.result.current.latestLoading).toBe(true);
    expect(hook.result.current.olderLoading).toBe(true);
    expect(hook.result.current.latestError).toBeNull();
    expect(hook.result.current.olderError).toBeNull();
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([45, 16]);
    await finish(older, page([15, 1]));
    await finish(latest, page([80, 51], true));
    expect(hook.result.current.latestLoading).toBe(false);
    expect(hook.result.current.olderLoading).toBe(false);
    expect(hook.saved.values.get("history:interrupted")).toBeNull();
  });

  it.each(["success", "failure"])("recovers after %s", async (outcome) => {
    const hook = mount();
    await act(async () => {});
    const latestError = new BackendError(
      "request_failed",
      "Latest unavailable",
    );
    const olderError = new BackendError(
      "request_failed",
      "Earlier unavailable",
    );
    vi.mocked(backend.agentHistory)
      .mockRejectedValueOnce(latestError)
      .mockRejectedValueOnce(olderError);
    await act(async () => hook.result.current.loadLatest());
    await act(async () => hook.result.current.loadOlder());
    await emit({ type: "connection.closed" });
    expect(hook.result.current.latestError).toBe(latestError);
    expect(hook.result.current.olderError).toBe(olderError);
    const latest = deferred<AgentHistoryPage>();
    const older = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistory)
      .mockReturnValueOnce(latest.promise)
      .mockReturnValueOnce(older.promise);
    await emit({ type: "connection.restored" });
    expect(hook.result.current.latestError).toBe(latestError);
    expect(hook.result.current.olderError).toBe(olderError);
    if (outcome === "failure") {
      await act(async () => latest.reject(new Error("Still unavailable")));
      expect(hook.result.current.latestError?.message).toBe(
        "Still unavailable",
      );
      vi.mocked(backend.agentHistory).mockResolvedValueOnce(
        page([80, 51], true),
      );
      await act(async () => hook.result.current.loadLatest());
    } else await finish(latest, page([80, 51], true));
    await finish(older, page([15, 1]));
    expect(hook.result.current.latestError).toBeNull();
    expect(hook.result.current.olderError).toBeNull();
  });

  it.each(["success", "failure"])("ignores unmounted %s", async (outcome) => {
    const hook = mount();
    await act(async () => {});
    const pending = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistory).mockReturnValueOnce(pending.promise);
    await act(async () => {
      void hook.result.current.loadOlder();
    });
    const saved = hook.saved.values.get("history");
    const loads = hook.result.current;
    hook.unmount();
    expect(listeners.size).toBe(0);
    await act(async () => {
      if (outcome === "success") pending.resolve(page([15, 1]));
      else pending.reject(new Error("Unmounted failure"));
      await loads.loadLatest();
      await loads.loadOlder();
    });
    expect(hook.saved.values.get("history")).toBe(saved);
    expect(hook.saved.values.get("history:interrupted")).toBe(16);
    expect(backend.agentHistory).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("isolates old window %s", async (outcome) => {
    const first = cache();
    const second = cache();
    const pending = deferred<AgentHistoryPage>();
    const recovered = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistory)
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(recovered.promise);
    let current!: ReturnType<typeof useConversationHistory>;
    const initialRuns: AgentRun[] = [];
    const beforeOlder = vi.fn();
    function Probe({ windowNumber }: { windowNumber: number }) {
      current = useConversationHistory({
        agentId: 2,
        windowNumber,
        isCurrent: true,
        initialRuns,
        beforeOlder,
      });
      return null;
    }
    const view = render(
      <WindowContext.Provider key={1} value={first}>
        <Probe windowNumber={1} />
      </WindowContext.Provider>,
    );
    view.rerender(
      <WindowContext.Provider key={2} value={second}>
        <Probe windowNumber={2} />
      </WindowContext.Provider>,
    );
    expect(listeners.size).toBe(1);
    await act(async () => {
      if (outcome === "success") pending.resolve(page([99]));
      else pending.reject(new Error("Previous window"));
    });
    expect(current.latestLoading).toBe(true);
    expect(current.latestError).toBeNull();
    expect((first.values.get("history") as WindowHistoryState).runs).toEqual(
      [],
    );
    await finish(recovered, page([4], false, 2));
    expect(current.history.runs.map((entry) => entry.sequence)).toEqual([4]);
    expect(current.latestLoading).toBe(false);
    expect((first.values.get("history") as WindowHistoryState).ranges).toEqual(
      [],
    );
  });

  it("preserves completed earlier window data and filters unrelated events", async () => {
    const saved = cache({
      runs: [run(4)],
      ranges: [{ upper: 4, lower: Number.NEGATIVE_INFINITY }],
    });
    const hook = mount(saved, false);
    expect(backend.agentHistory).not.toHaveBeenCalled();
    await emit({ type: "turn.completed", agent_id: 2 });
    await emit({ type: "turn.started", agent_id: 9 });
    await act(async () => hook.result.current.loadOlder());
    expect(backend.agentHistory).not.toHaveBeenCalled();
    expect(hook.beforeOlder).not.toHaveBeenCalled();
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([4]);
    expect(hook.result.current.hasOlder).toBe(false);
    hook.rerender({ ...hook.props, isCurrent: true });
    await act(async () => {});
    expect(backend.agentHistory).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
  });

  it("starts reads after an initially disconnected hook receives restoration", async () => {
    disconnected = true;
    const hook = mount();
    expect(backend.agentHistory).not.toHaveBeenCalled();
    expect(hook.result.current.latestLoading).toBe(false);
    await emit({ type: "connection.restored" });
    expect(backend.agentHistory).toHaveBeenCalledTimes(1);
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([45, 16]);
  });

  it("ignores the discarded StrictMode request and releases the current subscription", async () => {
    const first = deferred<AgentHistoryPage>();
    const second = deferred<AgentHistoryPage>();
    vi.mocked(backend.agentHistory)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const saved = cache();
    const initialRuns: AgentRun[] = [];
    const beforeOlder = vi.fn();
    const hook = renderHook(
      () =>
        useConversationHistory({
          agentId: 2,
          windowNumber: 1,
          isCurrent: true,
          initialRuns,
          beforeOlder,
        }),
      {
        reactStrictMode: true,
        wrapper: ({ children }: { children: ReactNode }) => (
          <WindowContext.Provider value={saved}>
            {children}
          </WindowContext.Provider>
        ),
      },
    );
    expect(listeners.size).toBe(1);
    expect(backend.agentHistory).toHaveBeenCalledTimes(2);
    await finish(first, page([99]));
    expect(hook.result.current.history.runs).toEqual([]);
    expect(hook.result.current.latestLoading).toBe(true);
    await finish(second, page([45, 16], true));
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([45, 16]);
    hook.unmount();
    expect(listeners.size).toBe(0);
  });

  it.each([
    { ...page([4]), agent_id: 9 },
    page([4], false, 2),
    { ...page([4], true), next_before: 3 },
  ])("rejects invalid latest identity", async (invalid) => {
    vi.mocked(backend.agentHistory).mockResolvedValueOnce(invalid);
    const hook = mount();
    await act(async () => {});
    expect(hook.result.current.latestError?.message).toBe(
      "Window history identity does not match",
    );
    expect(hook.result.current.history.runs).toEqual([]);
    expect(hook.result.current.history.ranges).toEqual([]);
    expect(hook.result.current.latestLoading).toBe(false);
  });

  it("keeps the earlier cursor and data when an earlier page fails validation", async () => {
    const hook = mount();
    await act(async () => {});
    vi.mocked(backend.agentHistory).mockResolvedValueOnce(page([16, 1]));
    await act(async () => hook.result.current.loadOlder());
    expect(hook.result.current.olderError?.message).toBe(
      "Earlier history did not advance",
    );
    expect(hook.saved.values.get("history:interrupted")).toBe(16);
    expect(
      hook.result.current.history.runs.map((entry) => entry.sequence),
    ).toEqual([45, 16]);
    expect(hook.result.current.olderLoading).toBe(false);
  });
});
