import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, Spinner } from "@/components/ui/index";
import { ConversationSkeleton } from "@/features/members/activity-skeleton";
import { WindowHistory } from "@/features/members/activity-window";
import { ConversationFeed } from "@/features/members/conversation";
import {
  applyHistoryPage,
  createWindowHistory,
  mergeWindowSummary,
  type WindowHistoryState,
} from "@/features/members/history-state";
import {
  useWindowCache,
  useWindowState,
  type WindowCache,
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

function refreshWindowSummary(
  cache: WindowCache,
  windowNumber: number | null,
  summaries: AgentRun[],
) {
  const saved = cache.values.get("history") as WindowHistoryState | undefined;
  if (!saved) return;
  cache.values.set(
    "history",
    mergeWindowSummary(saved, windowNumber, summaries),
  );
}

export function ConversationHistory({
  agentId,
  initialRuns,
}: {
  agentId: number;
  initialRuns: AgentRun[];
}) {
  return (
    <WindowHistory
      agentId={agentId}
      initialRuns={initialRuns}
      mergeSummary={refreshWindowSummary}
    >
      {(windowNumber, isCurrent) => (
        <ConversationWindow
          agentId={agentId}
          initialRuns={initialRuns}
          windowNumber={windowNumber}
          isCurrent={isCurrent}
        />
      )}
    </WindowHistory>
  );
}

function ConversationWindow({
  agentId,
  initialRuns,
  windowNumber,
  isCurrent,
}: {
  agentId: number;
  initialRuns: AgentRun[];
  windowNumber: number | null;
  isCurrent: boolean;
}) {
  const cache = useWindowCache();
  const [history, setHistory] = useWindowState<WindowHistoryState>(
    "history",
    () => createWindowHistory(windowNumber, initialRuns),
  );
  const { runs, ranges } = history;
  const before = ranges[0]?.lower;
  const hasOlder = before !== undefined && Number.isFinite(before);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useWindowState<BackendError | null>(
    "history:error",
    null,
  );
  const [latestLoading, setLatestLoading] = useState(false);
  const [latestError, setLatestError] = useWindowState<BackendError | null>(
    "history:latestError",
    null,
  );
  const latestGeneration = useRef(0);
  const latestBusy = useRef(false);
  const latestDirty = useRef(false);
  const connected = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const [interruptedCursor, setInterruptedCursor] = useWindowState<
    number | null
  >("history:interrupted", null);
  const interruptedBefore = useRef<number | null>(interruptedCursor);
  const anchor = useRef<{ node: Element; top: number } | null>(null);
  const capture = useRef<() => void>(() => {});

  useEffect(
    () => () => {
      generation.current += 1;
      latestGeneration.current += 1;
      busy.current = false;
      latestBusy.current = false;
    },
    [],
  );

  const loadLatest = useCallback(
    async function refresh() {
      if (!connected.current) return;
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

  useEffect(() => {
    setHistory((current) =>
      mergeWindowSummary(current, windowNumber, initialRuns),
    );
    const saved = cache?.values.get("history") as
      | WindowHistoryState
      | undefined;
    if (isCurrent || !saved?.ranges.length) void loadLatest();
  }, [initialRuns, windowNumber, isCurrent, cache, loadLatest, setHistory]);

  useLayoutEffect(() => {
    const content = root.current;
    if (!content) return;
    let parent = content.parentElement;
    while (
      parent &&
      !["auto", "scroll"].includes(getComputedStyle(parent).overflowY)
    )
      parent = parent.parentElement;
    const scroll = parent;
    if (!scroll) return;
    const remember = () => {
      const top = scroll.getBoundingClientRect().top;
      const bottom = scroll.getBoundingClientRect().bottom;
      const visible = Array.from(
        content.querySelectorAll(
          "[data-activity-anchor], [data-activity-anchor] :is(p, pre, li, img, summary, button, time)",
        ),
      ).filter((entry) => {
        const rect = entry.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > top && rect.top < bottom;
      });
      let node: Element | undefined;
      for (const entry of visible) {
        if (!node || node.contains(entry)) node = entry;
        else break;
      }
      anchor.current = node
        ? { node, top: node.getBoundingClientRect().top - top }
        : null;
      const unit = node?.closest("[data-activity-anchor]");
      if (cache && node && unit) {
        const path: number[] = [];
        let child = node;
        while (child !== unit && child.parentElement) {
          path.unshift(Array.from(child.parentElement.children).indexOf(child));
          child = child.parentElement;
        }
        cache.position = {
          identity: unit.getAttribute("data-activity-anchor") ?? "",
          path,
          top: node.getBoundingClientRect().top - top,
          scrollTop: scroll.scrollTop,
        };
      }
    };
    const restore = () => {
      const position = cache?.position;
      if (!position) return;
      let node: Element | undefined = Array.from(
        content.querySelectorAll("[data-activity-anchor]"),
      ).find(
        (unit) =>
          unit.getAttribute("data-activity-anchor") === position.identity,
      );
      for (const index of position.path) node = node?.children[index];
      if (node) {
        scroll.scrollTop +=
          node.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          position.top;
        anchor.current = { node, top: position.top };
      } else scroll.scrollTop = position.scrollTop;
    };
    const onScroll = () => {
      if (cache)
        cache.following =
          scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 24;
      remember();
    };
    capture.current = remember;
    scroll.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (cache?.following)
        scroll.scrollTop = Math.max(
          0,
          scroll.scrollHeight - scroll.clientHeight,
        );
      else {
        const saved = anchor.current;
        if (saved?.node.isConnected) {
          const top =
            saved.node.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top;
          scroll.scrollTop += top - saved.top;
        } else restore();
      }
      remember();
    });
    if (cache?.following)
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    else restore();
    observer.observe(content);
    remember();
    return () => {
      remember();
      observer.disconnect();
      scroll.removeEventListener("scroll", onScroll);
      capture.current = () => {};
      generation.current += 1;
    };
  }, [cache]);

  const loadOlder = useCallback(
    async (cursor = interruptedBefore.current ?? before) => {
      if (busy.current || cursor === undefined || !Number.isFinite(cursor))
        return;
      busy.current = true;
      interruptedBefore.current = cursor;
      setInterruptedCursor(cursor);
      if (cache) cache.following = false;
      const current = ++generation.current;
      capture.current();
      setLoading(true);
      try {
        const page = await backend.agentHistory(
          agentId,
          cursor,
          30,
          undefined,
          30,
          { window_number: windowNumber },
        );
        if (current !== generation.current) return;
        setHistory((saved) =>
          applyHistoryPage(saved, page, {
            agentId,
            windowNumber,
            before: cursor,
          }),
        );
        interruptedBefore.current = null;
        setInterruptedCursor(null);
        setError(null);
      } catch (failure) {
        if (current === generation.current) {
          setError(historyFailure(failure));
        }
      } finally {
        if (current === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [
      agentId,
      before,
      windowNumber,
      cache,
      setHistory,
      setError,
      setInterruptedCursor,
    ],
  );

  useEffect(
    () =>
      backend.onEvent((event) => {
        if (event.type === "connection.closed") {
          connected.current = false;
          generation.current += 1;
          latestGeneration.current += 1;
          latestBusy.current = false;
          busy.current = false;
          setLoading(false);
          setLatestLoading(false);
        }
        if (event.type === "connection.restored") {
          connected.current = true;
          void loadLatest();
          if (interruptedBefore.current !== null)
            void loadOlder(interruptedBefore.current);
        }
        if (
          isCurrent &&
          event.type.startsWith("turn.") &&
          event.agent_id === agentId
        )
          void loadLatest();
      }),
    [agentId, isCurrent, loadLatest, loadOlder],
  );

  return (
    <div ref={root} className="flex w-full min-w-0 flex-col gap-4">
      {runs.length === 0 &&
      ranges.length === 0 &&
      !latestError &&
      !backend.disconnected ? (
        <ConversationSkeleton label="Loading window history" />
      ) : null}
      {latestError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-danger"
        >
          <span className="wrap-anywhere">{latestError.message}</span>
          <Button
            size="sm"
            disabled={latestLoading}
            onClick={() => void loadLatest()}
          >
            Retry window history
          </Button>
        </div>
      ) : null}
      {hasOlder ? (
        <div className="flex flex-col items-start gap-2">
          <Button disabled={loading} onClick={() => void loadOlder()}>
            {loading ? <Spinner label="Loading earlier history" /> : null}
            {error ? "Retry earlier history" : "Load earlier history"}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-danger wrap-anywhere">
              {error.message}
            </p>
          ) : null}
        </div>
      ) : null}
      <ConversationFeed
        agentId={agentId}
        runs={[...runs].reverse()}
        loading={latestLoading || ranges.length === 0}
      />
    </div>
  );
}
