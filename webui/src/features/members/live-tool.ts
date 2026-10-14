import { useEffect, useRef, useState } from "react";
import {
  BackendError,
  backend,
  type HistoryMessages,
  type LiveTool,
} from "@/lib/backend";

type ObservedTool = {
  epoch: string;
  revision: number;
  tool: LiveTool;
  content: HistoryMessages | null;
};

export function useLiveTool({
  agentId,
  sequence,
  ordinal,
  partIndex,
  toolCallId,
  requestId,
  enabled,
  opened,
}: {
  agentId: number;
  sequence: number;
  ordinal: number;
  partIndex: number;
  toolCallId: string;
  requestId?: string;
  enabled: boolean;
  opened: boolean;
}) {
  const [observed, setObserved] = useState<ObservedTool | null>(null);
  const [error, setError] = useState<BackendError | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(observed);
  latest.current = observed;
  const expanded = useRef(opened);
  expanded.current = opened;
  const refresh = useRef<(() => Promise<void>) | null>(null);
  const previousOpened = useRef(opened);

  useEffect(() => {
    if (!enabled) {
      latest.current = null;
      setObserved(null);
      setError(null);
    }
    let active = true;
    let connected = !backend.disconnected;
    let generation = 0;
    let pending: Promise<void> | null = null;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let confirmedEpoch: string | null = null;
    let confirmedRevision = 0;
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const load = (): Promise<void> => {
      if (!active || !connected || !enabled) return Promise.resolve();
      clearTimer();
      if (pending) {
        dirty = true;
        return pending;
      }
      const current = generation;
      dirty = false;
      setLoading(true);
      const operation = Promise.resolve().then(async () => {
        if (!active || current !== generation) return;
        try {
          for (;;) {
            try {
              const page = await backend.agentLive(
                agentId,
                sequence,
                ordinal,
                partIndex > 0 ? partIndex - 1 : undefined,
                1,
              );
              if (!active || current !== generation) return;
              if (
                page.turn &&
                page.runtime_epoch === confirmedEpoch &&
                page.turn.live_revision < confirmedRevision
              ) {
                dirty = true;
              } else {
                if (
                  page.turn &&
                  (page.turn.agent_id !== agentId ||
                    page.turn.sequence !== sequence)
                )
                  throw new Error("Observed tool activity does not match");
                const request = page.turn?.requests[0];
                if (
                  request &&
                  (request.ordinal !== ordinal ||
                    (requestId !== undefined &&
                      request.request_id !== requestId))
                )
                  throw new Error("Observed tool request does not match");
                const tool = request?.tools[0];
                if (
                  tool &&
                  (tool.part_index !== partIndex ||
                    tool.tool_call_id !== toolCallId)
                )
                  throw new Error("Observed tool part does not match");
                if (!tool || !page.turn) {
                  latest.current = null;
                  setObserved(null);
                } else {
                  const previous = latest.current;
                  let content =
                    previous?.epoch === page.runtime_epoch &&
                    previous.tool.content_version === tool.content_version
                      ? previous.content
                      : null;
                  if (
                    expanded.current &&
                    tool.has_result &&
                    !tool.saved &&
                    content === null
                  ) {
                    content = await backend.agentLiveRead(
                      agentId,
                      sequence,
                      ordinal,
                      partIndex,
                      page.runtime_epoch,
                      "tool",
                      tool.content_version,
                    );
                    if (!active || current !== generation) return;
                  }
                  if (
                    page.runtime_epoch === confirmedEpoch &&
                    page.turn.live_revision < confirmedRevision
                  ) {
                    dirty = true;
                  } else {
                    const value = {
                      epoch: page.runtime_epoch,
                      revision: page.turn.live_revision,
                      tool,
                      content,
                    };
                    latest.current = value;
                    setObserved(value);
                  }
                }
                setError(null);
              }
            } catch (failure) {
              if (!active || current !== generation) return;
              if (
                failure instanceof BackendError &&
                failure.code === "live_changed"
              ) {
                dirty = true;
              } else {
                setError(
                  failure instanceof BackendError
                    ? failure
                    : new BackendError(
                        "live_read_failed",
                        failure instanceof Error
                          ? failure.message
                          : String(failure),
                      ),
                );
              }
            }
            if (!dirty || !active || current !== generation) return;
            dirty = false;
          }
        } finally {
          if (active && current === generation && pending === operation) {
            pending = null;
            setLoading(false);
          }
        }
      });
      pending = operation;
      return operation;
    };
    refresh.current = load;
    const schedule = (immediate = false) => {
      if (!active || !connected || !enabled) return;
      if (pending || immediate) void load();
      else if (timer === null)
        timer = setTimeout(() => {
          timer = null;
          void load();
        }, 150);
    };
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        connected = false;
        generation += 1;
        pending = null;
        dirty = false;
        clearTimer();
        confirmedEpoch = null;
        confirmedRevision = 0;
        latest.current = null;
        setObserved(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (event.type === "connection.restored") {
        connected = true;
        generation += 1;
        void load();
        return;
      }
      if (
        event.agent_id === agentId &&
        event.sequence === sequence &&
        (event.type === "turn.finished" ||
          (event.type === "tool.updated" &&
            (event.ordinal === undefined || event.ordinal === ordinal) &&
            (event.part_index === undefined || event.part_index === partIndex)))
      ) {
        if (
          event.saved === true &&
          typeof event.runtime_epoch === "string" &&
          typeof event.live_revision === "number"
        ) {
          if (confirmedEpoch !== event.runtime_epoch) confirmedRevision = 0;
          confirmedEpoch = event.runtime_epoch;
          confirmedRevision = Math.max(confirmedRevision, event.live_revision);
        }
        schedule(event.type === "turn.finished");
      }
    });
    void load();
    return () => {
      active = false;
      clearTimer();
      pending = null;
      off();
      refresh.current = null;
    };
  }, [agentId, sequence, ordinal, partIndex, toolCallId, requestId, enabled]);

  useEffect(() => {
    if (opened && !previousOpened.current) void refresh.current?.();
    previousOpened.current = opened;
  }, [opened]);

  return {
    observed,
    error,
    loading,
    retry: () => {
      if (!refresh.current) throw new Error("Observed tool read is inactive");
      void refresh.current();
    },
  };
}
