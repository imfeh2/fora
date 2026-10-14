import { afterEach, expect, it, vi } from "vitest";
import {
  AgentGenerationReader,
  type AgentGenerationState,
} from "@/features/members/generation";
import {
  BackendError,
  type BackendEvent,
  backend,
  type GenerationPart,
  type GenerationPartPage,
} from "@/lib/backend";

const key = {
  agent_id: 2,
  sequence: 4,
  ordinal: 1,
  request_id: "request",
  run_id: "run",
};
const listeners = new Set<(event: BackendEvent) => void>();
function part(index = 0, revision = 1): GenerationPart {
  return {
    key: { ...key, part_index: index },
    part_kind: "text",
    revision,
    status: "generating",
    error: null,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    tool_name: null,
    tool_call_id: null,
  };
}
function page(
  parts: GenerationPart[],
  next: number | null = null,
): GenerationPartPage {
  return {
    agent_id: 2,
    sequence: 4,
    ordinal: 1,
    parts,
    has_more: next !== null,
    next_after: next,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const states: AgentGenerationState[] = [];
  const reader = new AgentGenerationReader(key, (state) => states.push(state));
  const latest = () => states[states.length - 1];
  return { reader, latest };
}
function emit(type: string, fields = {}) {
  for (const listener of listeners)
    listener({
      type,
      ...key,
      part_index: 0,
      revision: 2,
      ...fields,
    } as BackendEvent);
}

afterEach(() => {
  listeners.clear();
  vi.restoreAllMocks();
});

it("subscribes before a paged snapshot and reads only the changed part afterward", async () => {
  const { reader, latest } = setup();
  const read = vi
    .spyOn(backend, "agentGenerationParts")
    .mockImplementation(async (_agent, _sequence, _ordinal, after, limit) => {
      expect(listeners.size).toBe(1);
      return limit === 1
        ? page([part(0, 2)])
        : after === undefined
          ? page([part(0)], 0)
          : page([part(1)]);
    });
  await reader.start();
  expect(latest().parts.map((part) => part.key.part_index)).toEqual([0, 1]);
  emit("turn.generation");
  await vi.waitFor(() => expect(latest().parts[0].revision).toBe(2));
  expect(read.mock.calls.map((call) => [call[3], call[4]])).toEqual([
    [undefined, 50],
    [0, 50],
    [undefined, 1],
  ]);
  expect(latest().parts[1].revision).toBe(1);
  reader.dispose();
  expect(listeners.size).toBe(0);
});

it("keeps one request in flight and consumes a newer revision received during it", async () => {
  const { reader, latest } = setup();
  const pending = deferred<GenerationPartPage>();
  const read = vi
    .spyOn(backend, "agentGenerationParts")
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(page([part(0, 3)]));
  const starting = reader.start();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  emit("turn.generation", { revision: 3 });
  expect(read).toHaveBeenCalledOnce();
  pending.resolve(page([part(0, 1)]));
  await starting;
  expect(read).toHaveBeenCalledTimes(2);
  expect(latest().parts[0].revision).toBe(3);
  expect(latest().loading).toBe(false);
  reader.dispose();
});

it("ignores events from a different request or Turn", async () => {
  const { reader } = setup();
  const read = vi
    .spyOn(backend, "agentGenerationParts")
    .mockResolvedValue(page([part()]));
  await reader.start();
  emit("turn.generation", { request_id: "other" });
  emit("turn.generation", { run_id: "other" });
  emit("turn.generation", { sequence: 5 });
  expect(read).toHaveBeenCalledOnce();
  reader.dispose();
});

it("preserves the restored request when an older request finally returns", async () => {
  const { reader, latest } = setup();
  const old = deferred<GenerationPartPage>();
  const restored = deferred<GenerationPartPage>();
  const read = vi
    .spyOn(backend, "agentGenerationParts")
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(restored.promise);
  const first = reader.start();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  emit("connection.closed");
  emit("connection.restored");
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  old.resolve(page([part(0, 1)]));
  await first;
  expect(latest().loading).toBe(true);
  restored.resolve(page([part(0, 4)]));
  await vi.waitFor(() => expect(latest().loading).toBe(false));
  expect(latest().parts[0].revision).toBe(4);
  reader.dispose();
});

it("clears readable metadata on permission failure and recovers through refresh", async () => {
  const { reader, latest } = setup();
  const read = vi
    .spyOn(backend, "agentGenerationParts")
    .mockResolvedValue(page([part()]));
  await reader.start();
  read.mockRejectedValueOnce(
    new BackendError("not_permitted", "Access denied"),
  );
  await reader.refresh();
  expect(latest().parts).toEqual([]);
  expect(latest().error?.code).toBe("not_permitted");
  await reader.refresh();
  expect(latest().parts).toHaveLength(1);
  expect(latest().error).toBeNull();
  reader.dispose();
});
