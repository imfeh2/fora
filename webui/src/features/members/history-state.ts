import type {
  AgentHistoryPage,
  AgentHistoryRun,
  AgentRun,
} from "@/lib/backend";

export type HistoryRange = { upper: number; lower: number };
export type WindowHistoryState = {
  runs: AgentHistoryRun[];
  ranges: HistoryRange[];
};

export function historyRun(run: AgentRun): AgentHistoryRun {
  const requestCount = run.request_count ?? 0;
  return {
    sequence: run.sequence,
    run_id: run.run_id ?? "",
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    last_saved_at: run.last_saved_at ?? null,
    window_number: run.window_number ?? null,
    window_reset_at: run.window_reset_at ?? null,
    window_reason: run.window_reason ?? null,
    request_count: requestCount,
    usage: run.usage,
    error: run.error,
    legacy: requestCount === 0,
    reminded: run.reminded,
  };
}

export function mergeHistoryRuns(
  current: AgentHistoryRun[],
  incoming: AgentHistoryRun[],
): AgentHistoryRun[] {
  const runs = new Map(current.map((run) => [run.sequence, run]));
  for (const run of incoming) runs.set(run.sequence, run);
  return [...runs.values()].sort(
    (left, right) => right.sequence - left.sequence,
  );
}

export function mergeHistoryRanges(
  current: HistoryRange[],
  incoming: HistoryRange[],
): HistoryRange[] {
  const ranges: HistoryRange[] = [];
  for (const range of [...current, ...incoming].sort(
    (left, right) => right.upper - left.upper,
  )) {
    const previous = ranges[ranges.length - 1];
    if (previous && range.upper >= previous.lower)
      previous.lower = Math.min(previous.lower, range.lower);
    else ranges.push({ ...range });
  }
  return ranges;
}

export function createWindowHistory(
  windowNumber: number | null,
  summaries: AgentRun[],
): WindowHistoryState {
  return {
    runs: summaries
      .filter((run) => run.window_number === windowNumber)
      .map(historyRun),
    ranges: [],
  };
}

export function mergeWindowSummary(
  state: WindowHistoryState,
  windowNumber: number | null,
  summaries: AgentRun[],
): WindowHistoryState {
  return {
    ...state,
    runs: mergeHistoryRuns(
      state.runs,
      summaries
        .filter((run) => run.window_number === windowNumber)
        .map(historyRun),
    ),
  };
}

export function applyHistoryPage(
  state: WindowHistoryState,
  page: AgentHistoryPage,
  identity: {
    agentId: number;
    windowNumber: number | null;
    before?: number;
  },
): WindowHistoryState {
  const { agentId, windowNumber, before } = identity;
  if (before === undefined) {
    if (
      page.agent_id !== agentId ||
      page.window_number !== windowNumber ||
      page.runs.some((run) => run.window_number !== windowNumber) ||
      (page.has_before &&
        (!page.runs.length ||
          page.next_before !==
            Math.min(...page.runs.map((run) => run.sequence))))
    )
      throw new Error("Window history identity does not match");
  } else if (
    page.agent_id !== agentId ||
    page.window_number !== windowNumber ||
    page.runs.some(
      (run) => run.sequence >= before || run.window_number !== windowNumber,
    ) ||
    (page.has_before &&
      (page.next_before === null ||
        page.next_before >= before ||
        page.runs.length === 0 ||
        page.next_before !== Math.min(...page.runs.map((run) => run.sequence))))
  )
    throw new Error("Earlier history did not advance");
  return {
    runs: mergeHistoryRuns(state.runs, page.runs),
    ranges: mergeHistoryRanges(state.ranges, [
      {
        upper:
          before ??
          (page.runs.length
            ? Math.max(...page.runs.map((run) => run.sequence))
            : Number.POSITIVE_INFINITY),
        lower: page.has_before
          ? Math.min(...page.runs.map((run) => run.sequence))
          : Number.NEGATIVE_INFINITY,
      },
    ]),
  };
}
