import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyHistoryPage,
  createWindowHistory,
  mergeWindowSummary,
  type WindowHistoryState,
} from "@/features/members/history-state";
import {
  useWindowCache,
  useWindowState,
} from "@/features/members/window-cache";
import { type AgentRun, BackendError, backend } from "@/lib/backend";

function historyFailure(failure: unknown): BackendError {
  return failure instanceof BackendError
    ? failure
    : new BackendError(
        "request_failed",
        failure instanceof Error ? failure.message : String(failure),
      );
}

export function useConversationHistory({
  agentId,
  windowNumber,
  isCurrent,
  initialRuns,
  beforeOlder,
}: {
  agentId: number;
  windowNumber: number | null;
  isCurrent: boolean;
  initialRuns: AgentRun[];
  beforeOlder: () => void;
}) {
  const cache = useWindowCache();
  const [history, setHistory] = useWindowState<WindowHistoryState>(
    "history",
    () => createWindowHistory(windowNumber, initialRuns),
  );
  const before = history.ranges[0]?.lower;
  const hasOlder = before !== undefined && Number.isFinite(before);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useWindowState<BackendError | null>(
    "history:error",
    null,
  );
  const [latestLoading, setLatestLoading] = useState(false);
  const [latestError, setLatestError] = useWindowState<BackendError | null>(
    "history:latestError",
    null,
  );
  const [interruptedCursor, setInterruptedCursor] = useWindowState<
    number | null
  >("history:interrupted", null);
  const interruptedBefore = useRef<number | null>(interruptedCursor);
  const latestGeneration = useRef(0);
  const olderGeneration = useRef(0);
  const latestBusy = useRef(false);
  const olderBusy = useRef(false);
  const latestDirty = useRef(false);
  const connected = useRef(!backend.disconnected);
  const mounted = useRef(true);

  const loadLatest = useCallback(
    async function refresh() {
      if (!mounted.current || !connected.current) return;
      if (latestBusy.current) {
        latestDirty.current = true;
        return;
      }
      latestBusy.current = true;
      latestDirty.current = false;
      const current = ++latestGeneration.current;
      setLatestLoading(true);
      try {
        const page = await backend.agentHistory(
          agentId,
          undefined,
          30,
          undefined,
          30,
          { window_number: windowNumber },
        );
        if (current !== latestGeneration.current) return;
        setHistory((saved) =>
          applyHistoryPage(saved, page, { agentId, windowNumber }),
        );
        setLatestError(null);
      } catch (failure) {
        if (current === latestGeneration.current)
          setLatestError(historyFailure(failure));
      } finally {
        if (current === latestGeneration.current) {
          latestBusy.current = false;
          setLatestLoading(false);
          if (latestDirty.current) void refresh();
        }
      }
    },
    [agentId, windowNumber, setHistory, setLatestError],
  );

  const loadOlder = useCallback(async () => {
    const cursor = interruptedBefore.current ?? before;
    if (
      !mounted.current ||
      !connected.current ||
      olderBusy.current ||
      cursor === undefined ||
      !Number.isFinite(cursor)
    )
      return;
    olderBusy.current = true;
    interruptedBefore.current = cursor;
    setInterruptedCursor(cursor);
    const current = ++olderGeneration.current;
    beforeOlder();
    setOlderLoading(true);
    try {
      const page = await backend.agentHistory(
        agentId,
        cursor,
        30,
        undefined,
        30,
        { window_number: windowNumber },
      );
      if (current !== olderGeneration.current) return;
      setHistory((saved) =>
        applyHistoryPage(saved, page, {
          agentId,
          windowNumber,
          before: cursor,
        }),
      );
      interruptedBefore.current = null;
      setInterruptedCursor(null);
      setOlderError(null);
    } catch (failure) {
      if (current === olderGeneration.current)
        setOlderError(historyFailure(failure));
    } finally {
      if (current === olderGeneration.current) {
        olderBusy.current = false;
        setOlderLoading(false);
      }
    }
  }, [
    agentId,
    before,
    windowNumber,
    beforeOlder,
    setHistory,
    setOlderError,
    setInterruptedCursor,
  ]);
  const currentLoads = useRef({ loadLatest, loadOlder });
  currentLoads.current = { loadLatest, loadOlder };

  useEffect(() => {
    mounted.current = true;
    connected.current = !backend.disconnected;
    return () => {
      mounted.current = false;
      olderGeneration.current += 1;
      latestGeneration.current += 1;
      latestBusy.current = false;
      olderBusy.current = false;
    };
  }, []);

  useEffect(
    () =>
      backend.onEvent((event) => {
        if (event.type === "connection.closed") {
          connected.current = false;
          olderGeneration.current += 1;
          latestGeneration.current += 1;
          latestBusy.current = false;
          olderBusy.current = false;
          setOlderLoading(false);
          setLatestLoading(false);
        }
        if (event.type === "connection.restored") {
          connected.current = true;
          void currentLoads.current.loadLatest();
          if (interruptedBefore.current !== null)
            void currentLoads.current.loadOlder();
        }
        if (
          isCurrent &&
          event.type.startsWith("turn.") &&
          event.agent_id === agentId
        )
          void currentLoads.current.loadLatest();
      }),
    [agentId, isCurrent],
  );

  useEffect(() => {
    setHistory((current) =>
      mergeWindowSummary(current, windowNumber, initialRuns),
    );
    const saved = cache?.values.get("history") as
      | WindowHistoryState
      | undefined;
    if (isCurrent || !saved?.ranges.length) void loadLatest();
  }, [initialRuns, windowNumber, isCurrent, cache, loadLatest, setHistory]);

  return {
    history,
    hasOlder,
    latestLoading,
    latestError,
    olderLoading,
    olderError,
    loadLatest,
    loadOlder,
  };
}
