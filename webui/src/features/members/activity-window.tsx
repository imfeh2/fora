import { RefreshCw } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/index";
import { SelectList } from "@/components/ui/select-list";
import { ConversationSkeleton } from "@/features/members/activity-skeleton";
import {
  type AgentHistoryWindow,
  type AgentRun,
  BackendError,
  backend,
} from "@/lib/backend";
import { formatTime } from "@/lib/format";

export type WindowPosition = {
  identity: string;
  path: number[];
  top: number;
  scrollTop: number;
};

export type WindowCache = {
  values: Map<string, unknown>;
  following: boolean;
  position: WindowPosition | null;
};

const WindowContext = createContext<WindowCache | null>(null);

export function useWindowCache() {
  return useContext(WindowContext);
}

export function useWindowState<T>(
  key: string,
  initial: T | (() => T),
): [T, (value: SetStateAction<T>) => void] {
  const cache = useWindowCache();
  const [value, update] = useState<T>(() => {
    if (cache?.values.has(key)) return cache.values.get(key) as T;
    const value =
      typeof initial === "function" ? (initial as () => T)() : initial;
    cache?.values.set(key, value);
    return value;
  });
  const current = useRef(value);
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const value =
        typeof next === "function"
          ? (next as (value: T) => T)(current.current)
          : next;
      current.current = value;
      cache?.values.set(key, value);
      update(value);
    },
    [cache, key],
  );
  return [value, setValue];
}

type WindowRange = { upper: number; lower: number };

function includeRange(
  ranges: WindowRange[],
  incoming: WindowRange,
): WindowRange[] {
  const merged: WindowRange[] = [];
  for (const range of [...ranges, incoming].sort(
    (left, right) => right.upper - left.upper,
  )) {
    const previous = merged[merged.length - 1];
    if (previous && range.upper >= previous.lower)
      previous.lower = Math.min(previous.lower, range.lower);
    else merged.push({ ...range });
  }
  return merged;
}

function failure(error: unknown): BackendError {
  return error instanceof BackendError
    ? error
    : new BackendError(
        "history_failed",
        error instanceof Error ? error.message : String(error),
      );
}

export function windowEnd(window: AgentHistoryWindow): string {
  if (window.is_current) return "In progress";
  if (window.end_reason === "prepared") return "Normal compaction";
  if (window.end_reason === "overflow") return "Overflow rebuild";
  return "End unknown";
}

export function windowStart(window: AgentHistoryWindow): string {
  if (window.start_reason === "prepared")
    return "Started after normal compaction";
  if (window.start_reason === "overflow")
    return "Started after overflow rebuild";
  if (window.number === 1 && window.start_reason === null)
    return "Initial context";
  return "Start reason unknown";
}

function WindowPicker({
  windows,
  selected,
  hasUnassigned,
  onChoose,
}: {
  windows: AgentHistoryWindow[];
  selected: number | null;
  hasUnassigned: boolean;
  onChoose: (number: number | null) => void;
}) {
  const options = windows.map((window) => ({
    value: String(window.number),
    label: window.started_at
      ? formatTime(window.started_at)
      : "Start time unknown",
    description: windowEnd(window),
    current: window.is_current,
  }));
  if (hasUnassigned)
    options.push({
      value: "unassigned",
      label: "Window information missing",
      description: "",
      current: false,
    });
  return (
    <div className="w-full max-w-[220px] max-[640px]:max-w-none">
      <SelectList
        label="Context window"
        optionsLabel="Context windows"
        options={options}
        value={selected === null ? "unassigned" : String(selected)}
        onChange={(value) =>
          onChoose(value === "unassigned" ? null : Number(value))
        }
      />
    </div>
  );
}

export function WindowHistory({
  agentId,
  initialRuns,
  mergeSummary,
  children,
}: {
  agentId: number;
  initialRuns: AgentRun[];
  mergeSummary: (
    cache: WindowCache,
    windowNumber: number | null,
    runs: AgentRun[],
  ) => void;
  children: (windowNumber: number | null, isCurrent: boolean) => ReactNode;
}) {
  const [windows, setWindows] = useState<AgentHistoryWindow[]>([]);
  const [selected, setSelected] = useState<number | null | undefined>(
    undefined,
  );
  const [hasUnassigned, setHasUnassigned] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const [olderError, setOlderError] = useState<BackendError | null>(null);
  const caches = useRef(new Map<number | null, WindowCache>());
  const selection = useRef<number | null | undefined>(undefined);
  const currentWindow = useRef<number | undefined>(undefined);
  const latestGeneration = useRef(0);
  const olderGeneration = useRef(0);
  const latestBusy = useRef(false);
  const olderBusy = useRef(false);
  const dirty = useRef(false);
  const connected = useRef(true);
  const directoryBefore = useRef<number | null>(null);
  const olderCursor = useRef<number | null>(null);
  const ranges = useRef<WindowRange[]>([]);
  const choose = (number: number | null) => {
    selection.current = number;
    setSelected(number);
  };

  const load = useCallback(
    async function refresh() {
      if (!connected.current) return;
      if (latestBusy.current) {
        dirty.current = true;
        return;
      }
      latestBusy.current = true;
      dirty.current = false;
      const generation = ++latestGeneration.current;
      setLoading(true);
      try {
        const page = await backend.agentHistoryWindows(agentId);
        if (generation !== latestGeneration.current) return;
        if (
          page.agent_id !== agentId ||
          !page.windows.some(
            (window) => window.number === page.current_window_number,
          ) ||
          (page.has_before &&
            page.next_before !==
              Math.min(...page.windows.map((window) => window.number)))
        )
          throw new Error("Window directory identity does not match");
        const previous = currentWindow.current;
        const follow =
          selection.current === previous &&
          caches.current.get(previous ?? null)?.following;
        currentWindow.current = page.current_window_number;
        setWindows((saved) => {
          const merged = new Map(
            saved.map((window) => [window.number, window]),
          );
          for (const window of page.windows) merged.set(window.number, window);
          return [...merged.values()]
            .map((window) => ({
              ...window,
              is_current: window.number === page.current_window_number,
            }))
            .sort((left, right) => right.number - left.number);
        });
        setHasUnassigned(page.has_unassigned);
        ranges.current = includeRange(ranges.current, {
          upper: Math.max(...page.windows.map((window) => window.number)),
          lower:
            page.has_before && page.next_before !== null
              ? page.next_before
              : Number.NEGATIVE_INFINITY,
        });
        directoryBefore.current = Number.isFinite(ranges.current[0].lower)
          ? ranges.current[0].lower
          : null;
        setBefore(directoryBefore.current);
        if (
          selection.current === undefined ||
          (follow && previous !== page.current_window_number)
        ) {
          selection.current = page.current_window_number;
          setSelected(page.current_window_number);
        }
        setError(null);
      } catch (error) {
        if (generation === latestGeneration.current) setError(failure(error));
      } finally {
        if (generation === latestGeneration.current) {
          latestBusy.current = false;
          setLoading(false);
          if (dirty.current) void refresh();
        }
      }
    },
    [agentId],
  );

  const loadOlder = useCallback(async () => {
    const cursor = olderCursor.current ?? directoryBefore.current;
    if (olderBusy.current || cursor === null || !connected.current) return;
    olderBusy.current = true;
    olderCursor.current = cursor;
    const generation = ++olderGeneration.current;
    setOlderLoading(true);
    try {
      const page = await backend.agentHistoryWindows(agentId, cursor);
      if (generation !== olderGeneration.current) return;
      if (
        page.agent_id !== agentId ||
        page.windows.some((window) => window.number >= cursor) ||
        (page.has_before &&
          (page.next_before === null ||
            page.next_before >= cursor ||
            page.next_before !==
              Math.min(...page.windows.map((window) => window.number))))
      )
        throw new Error("Window directory did not advance");
      setWindows((saved) => {
        const merged = new Map(saved.map((window) => [window.number, window]));
        for (const window of page.windows)
          merged.set(window.number, {
            ...window,
            is_current: window.number === currentWindow.current,
          });
        return [...merged.values()].sort(
          (left, right) => right.number - left.number,
        );
      });
      ranges.current = includeRange(ranges.current, {
        upper: cursor,
        lower:
          page.has_before && page.next_before !== null
            ? page.next_before
            : Number.NEGATIVE_INFINITY,
      });
      directoryBefore.current = Number.isFinite(ranges.current[0].lower)
        ? ranges.current[0].lower
        : null;
      setBefore(directoryBefore.current);
      olderCursor.current = null;
      setOlderError(null);
    } catch (error) {
      if (generation === olderGeneration.current) setOlderError(failure(error));
    } finally {
      if (generation === olderGeneration.current) {
        olderBusy.current = false;
        setOlderLoading(false);
      }
    }
  }, [agentId]);

  useEffect(() => {
    for (const [windowNumber, cache] of caches.current) {
      if (windowNumber !== selection.current)
        mergeSummary(cache, windowNumber, initialRuns);
    }
    void load();
  }, [initialRuns, mergeSummary, load]);
  useEffect(() => {
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        connected.current = false;
        latestGeneration.current += 1;
        olderGeneration.current += 1;
        latestBusy.current = false;
        olderBusy.current = false;
        setLoading(false);
        setOlderLoading(false);
      }
      if (event.type === "connection.restored") {
        connected.current = true;
        void load();
      }
      if (event.type.startsWith("turn.") && event.agent_id === agentId)
        void load();
    });
    return () => {
      latestGeneration.current += 1;
      olderGeneration.current += 1;
      latestBusy.current = false;
      olderBusy.current = false;
      off();
    };
  }, [agentId, load]);

  let cache: WindowCache | null = null;
  if (selected !== undefined) {
    cache = caches.current.get(selected) ?? {
      values: new Map(),
      following: true,
      position: null,
    };
    caches.current.set(selected, cache);
  }
  const window = windows.find((window) => window.number === selected);
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 bg-app px-3 py-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {selected !== undefined ? (
          <WindowPicker
            windows={windows}
            selected={selected}
            hasUnassigned={hasUnassigned}
            onChoose={choose}
          />
        ) : null}
        {before !== null ? (
          <Button
            size="sm"
            disabled={olderLoading}
            onClick={() => void loadOlder()}
          >
            {olderLoading ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : null}
            {olderError ? "Retry earlier windows" : "Load earlier windows"}
          </Button>
        ) : null}
        {error ? (
          <Button size="sm" disabled={loading} onClick={() => void load()}>
            Retry windows
          </Button>
        ) : null}
      </div>
      {error || olderError ? (
        <p role="alert" className="text-sm text-danger wrap-anywhere">
          {error?.message ?? olderError?.message}
        </p>
      ) : null}
      {selected === undefined && !error && !backend.disconnected ? (
        <ConversationSkeleton label="Loading windows" window />
      ) : null}
      {selected !== undefined && cache ? (
        <WindowContext.Provider key={selected ?? "unassigned"} value={cache}>
          <p className="flex items-center gap-2 text-xs text-fg-muted">
            <RefreshCw size={13} aria-hidden="true" />
            {window ? windowStart(window) : "Window information missing"}
          </p>
          {children(selected, window?.is_current ?? false)}
        </WindowContext.Provider>
      ) : null}
    </div>
  );
}
