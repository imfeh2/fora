import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { Button, Spinner } from "@/components/ui/index";
import { ConversationSkeleton } from "@/features/members/activity-skeleton";
import { WindowHistory } from "@/features/members/activity-window";
import { ConversationFeed } from "@/features/members/conversation";
import {
  mergeWindowSummary,
  type WindowHistoryState,
} from "@/features/members/history-state";
import { useConversationHistory } from "@/features/members/use-conversation-history";
import {
  useWindowCache,
  type WindowCache,
} from "@/features/members/window-cache";
import { type AgentRun, backend } from "@/lib/backend";

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

function useHistoryPosition(
  root: RefObject<HTMLDivElement | null>,
  cache: WindowCache | null,
) {
  const anchor = useRef<{ node: Element; top: number } | null>(null);
  const capture = useRef<() => void>(() => {});

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
          scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 40;
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
    };
  }, [cache, root]);

  return useCallback(() => {
    if (cache) cache.following = false;
    capture.current();
  }, [cache]);
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
  const root = useRef<HTMLDivElement>(null);
  const capture = useHistoryPosition(root, cache);
  const {
    history: { runs, ranges },
    hasOlder,
    latestLoading,
    latestError,
    olderLoading: loading,
    olderError: error,
    loadLatest,
    loadOlder,
  } = useConversationHistory({
    agentId,
    windowNumber,
    isCurrent,
    initialRuns,
    beforeOlder: capture,
  });

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
