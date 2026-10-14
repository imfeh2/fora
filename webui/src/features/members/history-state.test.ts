import { describe, expect, it } from "vitest";
import {
  applyHistoryPage,
  createWindowHistory,
  historyRun,
  mergeHistoryRanges,
  mergeHistoryRuns,
  mergeWindowSummary,
} from "@/features/members/history-state";
import type { AgentHistoryPage, AgentRun } from "@/lib/backend";

function summary(sequence: number, windowNumber: number | null = 1): AgentRun {
  return {
    sequence,
    status: "completed",
    started_at: "2026-10-13T00:00:00Z",
    completed_at: "2026-10-13T00:01:00Z",
    window_number: windowNumber,
    usage: null,
    error: null,
    effects: [],
  };
}

function page(
  upper: number,
  count: number,
  hasBefore = false,
  windowNumber: number | null = 1,
): AgentHistoryPage {
  return {
    agent_id: 2,
    window_number: windowNumber,
    runs: Array.from({ length: count }, (_, index) =>
      historyRun(summary(upper - index, windowNumber)),
    ),
    windows: [],
    has_before: hasBefore,
    next_before: hasBefore ? upper - count + 1 : null,
    windows_has_more: false,
    windows_next_after: null,
  };
}

const identity = { agentId: 2, windowNumber: 1 };

describe("history state", () => {
  it("preserves summary fields and supplies the existing history defaults", () => {
    const run = summary(4);
    expect(historyRun(run)).toEqual({
      sequence: 4,
      run_id: "",
      status: "completed",
      started_at: run.started_at,
      completed_at: run.completed_at,
      last_saved_at: null,
      window_number: 1,
      window_reset_at: null,
      window_reason: null,
      request_count: 0,
      usage: null,
      error: null,
      legacy: true,
      reminded: undefined,
    });
    const detailed = {
      ...run,
      run_id: "run-4",
      request_count: 2,
      last_saved_at: "2026-10-13T00:00:30Z",
      window_reset_at: "2026-10-13T00:00:20Z",
      window_reason: "prepared",
      usage: "{}",
      error: "saved error",
      reminded: [],
    };
    const { effects, ...fields } = detailed;
    expect(historyRun(detailed)).toEqual({ ...fields, legacy: false });
    expect(historyRun(detailed)).not.toHaveProperty("effects");
    expect(effects).toEqual([]);
  });

  it("merges runs by sequence with incoming fields and descending order", () => {
    const current = [historyRun(summary(2)), historyRun(summary(4))];
    const incoming = [
      historyRun({ ...summary(4), status: "running" }),
      historyRun(summary(3)),
    ];
    const original = structuredClone({ current, incoming });
    const merged = mergeHistoryRuns(current, incoming);
    expect(merged.map((run) => [run.sequence, run.status])).toEqual([
      [4, "running"],
      [3, "completed"],
      [2, "completed"],
    ]);
    expect({ current, incoming }).toEqual(original);
  });

  it.each([0, 5, 30])(
    "keeps pagination open for a %i-record summary during a pending older read",
    (count) => {
      const initial = Array.from({ length: count }, (_, index) =>
        summary(45 - index),
      );
      let state = createWindowHistory(1, initial);
      expect(state.ranges).toEqual([]);
      state = applyHistoryPage(state, page(45, 30, true), identity);
      expect(state.ranges).toEqual([{ upper: 45, lower: 16 }]);
      const snapshot = structuredClone(state);
      const refreshed = Array.from({ length: count }, (_, index) =>
        summary(80 - index),
      );
      state = mergeWindowSummary(state, 1, refreshed);
      expect(state.ranges).toEqual(snapshot.ranges);
      state = applyHistoryPage(state, page(80, 30, true), identity);
      expect(state.ranges).toEqual([
        { upper: 80, lower: 51 },
        { upper: 45, lower: 16 },
      ]);
      state = applyHistoryPage(state, page(15, 15), {
        ...identity,
        before: 16,
      });
      expect(state.ranges).toEqual([
        { upper: 80, lower: 51 },
        { upper: 45, lower: Number.NEGATIVE_INFINITY },
      ]);
      expect(state.runs).toHaveLength(75);
      expect(state.ranges[0].lower).toBe(51);
      state = applyHistoryPage(state, page(50, 30, true), {
        ...identity,
        before: 51,
      });
      expect(state.ranges).toEqual([
        { upper: 80, lower: Number.NEGATIVE_INFINITY },
      ]);
      expect(state.runs.map((run) => run.sequence)).toEqual(
        Array.from({ length: 80 }, (_, index) => 80 - index),
      );
      expect(Number.isFinite(state.ranges[0].lower)).toBe(false);
    },
  );

  it.each(["latest", "older"])(
    "preserves both pages when %s finishes first",
    (first) => {
      const initial = applyHistoryPage(
        createWindowHistory(1, []),
        page(45, 30, true),
        identity,
      );
      const latest = (state: typeof initial) =>
        applyHistoryPage(state, page(80, 30, true), identity);
      const older = (state: typeof initial) =>
        applyHistoryPage(state, page(15, 15), { ...identity, before: 16 });
      const merged =
        first === "latest" ? older(latest(initial)) : latest(older(initial));
      expect(merged.ranges).toEqual([
        { upper: 80, lower: 51 },
        { upper: 45, lower: Number.NEGATIVE_INFINITY },
      ]);
      expect(merged.runs).toHaveLength(75);
      expect(initial.ranges).toEqual([{ upper: 45, lower: 16 }]);
      expect(initial.runs).toHaveLength(30);
    },
  );

  it("filters assigned and unassigned summaries while retaining covered ranges", () => {
    const summaries = [summary(4, 1), summary(3, 2), summary(2, null)];
    const assigned = createWindowHistory(1, summaries);
    expect(assigned.runs.map((run) => run.sequence)).toEqual([4]);
    expect(
      createWindowHistory(null, summaries).runs.map((run) => run.sequence),
    ).toEqual([2]);
    const saved = applyHistoryPage(assigned, page(4, 1, true), identity);
    const snapshot = structuredClone(saved);
    const merged = mergeWindowSummary(saved, 1, [
      { ...summary(4, 1), status: "running" },
      summary(5, 2),
      summary(6, 1),
    ]);
    expect(merged.runs.map((run) => [run.sequence, run.status])).toEqual([
      [6, "completed"],
      [4, "running"],
    ]);
    expect(merged.ranges).toBe(saved.ranges);
    expect(saved).toEqual(snapshot);
  });

  it("merges overlaps and shared endpoints while preserving integer gaps", () => {
    const current = [{ upper: 45, lower: 16 }];
    const incoming = [
      { upper: 80, lower: 51 },
      { upper: 51, lower: 46 },
    ];
    const snapshot = structuredClone({ current, incoming });
    const ranges = mergeHistoryRanges(current, incoming);
    expect(ranges).toEqual([
      { upper: 80, lower: 46 },
      { upper: 45, lower: 16 },
    ]);
    expect(mergeHistoryRanges(ranges, [{ upper: 60, lower: 20 }])).toEqual([
      { upper: 80, lower: 16 },
    ]);
    expect({ current, incoming }).toEqual(snapshot);
  });

  it("uses the same interval rules for window directory numbers", () => {
    const latest = mergeHistoryRanges([], [{ upper: 10, lower: 8 }]);
    const refreshed = mergeHistoryRanges(latest, [{ upper: 14, lower: 12 }]);
    const older = mergeHistoryRanges(refreshed, [{ upper: 8, lower: 4 }]);
    expect(older).toEqual([
      { upper: 14, lower: 12 },
      { upper: 10, lower: 4 },
    ]);
    expect(mergeHistoryRanges(older, [{ upper: 12, lower: 7 }])).toEqual([
      { upper: 14, lower: 4 },
    ]);
  });

  it("marks an empty latest or older terminal page as fully covered", () => {
    expect(
      applyHistoryPage(createWindowHistory(1, []), page(0, 0), identity),
    ).toEqual({
      runs: [],
      ranges: [
        { upper: Number.POSITIVE_INFINITY, lower: Number.NEGATIVE_INFINITY },
      ],
    });
    const saved = applyHistoryPage(
      createWindowHistory(1, []),
      page(4, 2, true),
      identity,
    );
    const merged = applyHistoryPage(saved, page(0, 0), {
      ...identity,
      before: 3,
    });
    expect(merged.runs).toEqual(saved.runs);
    expect(merged.ranges).toEqual([
      { upper: 4, lower: Number.NEGATIVE_INFINITY },
    ]);
  });

  it.each([
    { agent_id: 3 },
    { window_number: 2 },
    { runs: [historyRun(summary(4, 2))] },
    { next_before: null },
    { next_before: 2 },
    { runs: [] },
  ])(
    "rejects an invalid latest page without changing saved state: %j",
    (invalid) => {
      const state = createWindowHistory(1, [summary(8)]);
      const snapshot = structuredClone(state);
      expect(() =>
        applyHistoryPage(state, { ...page(4, 2, true), ...invalid }, identity),
      ).toThrow("Window history identity does not match");
      expect(state).toEqual(snapshot);
    },
  );

  it.each([
    { agent_id: 3 },
    { window_number: 2 },
    { runs: [historyRun(summary(4, 2))] },
    { runs: [historyRun(summary(6))] },
    { next_before: null },
    { next_before: 6 },
    { next_before: 2 },
    { runs: [] },
  ])(
    "rejects an invalid older page without changing saved state: %j",
    (invalid) => {
      const state = applyHistoryPage(
        createWindowHistory(1, []),
        page(8, 3, true),
        identity,
      );
      const snapshot = structuredClone(state);
      expect(() =>
        applyHistoryPage(
          state,
          { ...page(5, 2, true), ...invalid },
          { ...identity, before: 6 },
        ),
      ).toThrow("Earlier history did not advance");
      expect(state).toEqual(snapshot);
    },
  );
});
