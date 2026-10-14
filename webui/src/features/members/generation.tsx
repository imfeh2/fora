import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/index";
import {
  GenerationResource,
  type GenerationResourceState,
} from "@/features/generation-resource";
import { GenerationIndicator } from "@/features/generation-state";
import { CopyTextButton, MarkdownContent } from "@/features/markdown";
import {
  BackendError,
  type BackendEvent,
  backend,
  type GenerationField,
  type GenerationKey,
  type GenerationPart,
  type HistoryValue,
} from "@/lib/backend";

export type AgentGenerationState = {
  parts: GenerationPart[];
  loading: boolean;
  error: BackendError | null;
};

function failure(error: unknown): BackendError {
  return error instanceof BackendError
    ? error
    : new BackendError(
        "generation_failed",
        error instanceof Error ? error.message : String(error),
      );
}

export function generationIdentity(key: GenerationKey): string {
  return JSON.stringify([
    key.agent_id,
    key.sequence,
    key.ordinal,
    key.part_index,
    key.request_id,
    key.run_id,
  ]);
}

export class AgentGenerationReader {
  #key: Omit<GenerationKey, "part_index">;
  #state: AgentGenerationState = { parts: [], loading: false, error: null };
  #publish: (state: AgentGenerationState) => void;
  #off: (() => void) | null = null;
  #epoch = 0;
  #closed = false;
  #paused = false;
  #active: Promise<void> | null = null;
  #all = false;
  #wanted = new Map<number, number>();

  constructor(
    key: Omit<GenerationKey, "part_index">,
    publish: (state: AgentGenerationState) => void,
  ) {
    this.#key = key;
    this.#publish = publish;
  }

  #commit(update: Partial<AgentGenerationState>) {
    this.#state = { ...this.#state, ...update };
    this.#publish(this.#state);
  }

  start(): Promise<void> {
    if (this.#off || this.#closed)
      throw new Error("Generation reader is unavailable");
    this.#off = backend.onEvent((event) => this.#event(event));
    return this.refresh();
  }

  #event(event: BackendEvent) {
    if (event.type === "connection.closed") {
      this.#paused = true;
      this.#epoch += 1;
      this.#active = null;
      this.#commit({ loading: false });
    } else if (event.type === "connection.restored") {
      this.#paused = false;
      void this.refresh();
    } else if (
      event.type === "turn.generation" &&
      event.agent_id === this.#key.agent_id &&
      event.sequence === this.#key.sequence &&
      event.ordinal === this.#key.ordinal &&
      event.request_id === this.#key.request_id &&
      event.run_id === this.#key.run_id &&
      typeof event.part_index === "number" &&
      typeof event.revision === "number"
    ) {
      this.#wanted.set(
        event.part_index,
        Math.max(this.#wanted.get(event.part_index) ?? 0, event.revision),
      );
      void this.#run();
    }
  }

  refresh(): Promise<void> {
    this.#all = true;
    return this.#run();
  }

  #run(): Promise<void> {
    if (this.#closed || this.#paused) return Promise.resolve();
    if (this.#active) return this.#active;
    const epoch = this.#epoch;
    const execute = async () => {
      this.#commit({ loading: true });
      while (this.#all || this.#wanted.size) {
        const all = this.#all;
        this.#all = false;
        const wanted = new Map(this.#wanted);
        this.#wanted.clear();
        const found = new Map(
          this.#state.parts.map((part) => [part.key.part_index, part]),
        );
        try {
          const positions = all ? [undefined] : [...wanted.keys()];
          for (const position of positions) {
            let after =
              position === undefined || position === 0
                ? undefined
                : position - 1;
            for (;;) {
              const page = await backend.agentGenerationParts(
                this.#key.agent_id,
                this.#key.sequence,
                this.#key.ordinal,
                after,
                position === undefined ? 50 : 1,
              );
              if (this.#closed || this.#paused || epoch !== this.#epoch) return;
              if (position !== undefined && page.parts.length !== 1)
                throw new Error("Generation part is unavailable");
              if (
                page.agent_id !== this.#key.agent_id ||
                page.sequence !== this.#key.sequence ||
                page.ordinal !== this.#key.ordinal ||
                page.has_more !== (page.next_after !== null)
              )
                throw new Error(
                  "Generation directory identity or cursor is invalid",
                );
              for (const part of page.parts) {
                const key = part.key;
                if (
                  key.agent_id !== this.#key.agent_id ||
                  key.sequence !== this.#key.sequence ||
                  key.ordinal !== this.#key.ordinal ||
                  key.request_id !== this.#key.request_id ||
                  key.run_id !== this.#key.run_id ||
                  !Number.isSafeInteger(key.part_index) ||
                  key.part_index < 0 ||
                  !Number.isSafeInteger(part.revision) ||
                  part.revision < 1
                )
                  throw new Error("Generation part identity is invalid");
                if (position !== undefined && key.part_index !== position)
                  throw new Error("Generation part is unavailable");
                if (part.revision < (wanted.get(key.part_index) ?? 0))
                  throw new Error(
                    "Generation part is older than its committed revision",
                  );
                const previous = found.get(key.part_index);
                if (!previous || part.revision >= previous.revision)
                  found.set(key.part_index, part);
              }
              if (position !== undefined || !page.has_more) break;
              if (page.next_after === null || page.next_after <= (after ?? -1))
                throw new Error("Generation directory did not advance");
              after = page.next_after;
            }
          }
          this.#commit({
            parts: [...found.values()].sort(
              (left, right) => left.key.part_index - right.key.part_index,
            ),
            error: null,
          });
        } catch (error) {
          if (this.#closed || this.#paused || epoch !== this.#epoch) return;
          const problem = failure(error);
          this.#commit({
            error: problem,
            ...(["not_found", "not_permitted", "permission_denied"].includes(
              problem.code,
            )
              ? { parts: [] }
              : {}),
          });
          return;
        }
      }
    };
    const operation = Promise.resolve()
      .then(execute)
      .finally(() => {
        if (this.#active !== operation || epoch !== this.#epoch) return;
        this.#active = null;
        this.#commit({ loading: false });
      });
    this.#active = operation;
    return operation;
  }

  dispose(): void {
    this.#closed = true;
    this.#epoch += 1;
    this.#off?.();
    this.#off = null;
    this.#active = null;
  }
}

export function AgentGenerationWatcher({
  request,
  onChange,
}: {
  request: Omit<GenerationKey, "part_index">;
  onChange: (state: AgentGenerationState) => void;
}) {
  const changed = useRef(onChange);
  changed.current = onChange;
  const reader = useRef<AgentGenerationReader | null>(null);
  const [state, setState] = useState<AgentGenerationState>({
    parts: [],
    loading: false,
    error: null,
  });
  useEffect(() => {
    const current = new AgentGenerationReader(request, (state) => {
      setState(state);
      changed.current(state);
    });
    reader.current = current;
    void current.start();
    return () => {
      current.dispose();
      if (reader.current === current) reader.current = null;
    };
  }, [
    request.agent_id,
    request.sequence,
    request.ordinal,
    request.request_id,
    request.run_id,
  ]);
  return state.error ? (
    <div role="alert" className="text-sm text-danger">
      <p>{state.error.message}</p>
      <Button
        size="sm"
        disabled={state.loading}
        onClick={() => void reader.current?.refresh()}
      >
        Retry generation
      </Button>
    </div>
  ) : null;
}

export function GenerationContent({
  part,
  field,
  renderArgs,
}: {
  part: GenerationPart;
  field: GenerationField;
  renderArgs?: (value: HistoryValue) => ReactNode;
}) {
  const [state, setState] = useState<GenerationResourceState<GenerationPart>>({
    data: null,
    loading: false,
    error: null,
  });
  const resource = useRef<GenerationResource<GenerationPart> | null>(null);
  const identity = generationIdentity(part.key);
  useEffect(() => {
    const key = part.key;
    const current = new GenerationResource<GenerationPart>(
      async () => {
        const page = await backend.agentGenerationParts(
          key.agent_id,
          key.sequence,
          key.ordinal,
          key.part_index === 0 ? undefined : key.part_index - 1,
          1,
        );
        const metadata = page.parts[0];
        if (!metadata || generationIdentity(metadata.key) !== identity)
          throw new Error("Generation content identity changed");
        const text = await backend.agentGenerationText(
          key,
          metadata.revision,
          field,
        );
        if (generationIdentity(text.key) !== identity || text.field !== field)
          throw new Error("Generation text identity changed");
        return { metadata, text };
      },
      async (saved, offset) => {
        const text = await backend.agentGenerationText(
          saved.metadata.key,
          saved.metadata.revision,
          field,
          offset,
        );
        if (generationIdentity(text.key) !== identity || text.field !== field)
          throw new Error("Generation text identity changed");
        return text;
      },
      (metadata) => metadata.revision,
      setState,
    );
    resource.current = current;
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") current.pause();
      if (event.type === "connection.restored") void current.resume();
    });
    void current.refresh();
    return () => {
      off();
      current.dispose();
      if (resource.current === current) resource.current = null;
    };
  }, [identity, field]);
  useEffect(() => {
    void resource.current?.refresh(part.revision);
  }, [part.revision]);
  const saved = state.data;
  const metadata = saved?.metadata ?? part;
  const source = saved?.text.value ?? "";
  const markdown = field === "content";
  let args: HistoryValue = source;
  if (!markdown && saved && !saved.text.has_more && source.length > 0) {
    try {
      args = JSON.parse(source) as HistoryValue;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return (
    <div className="history-text min-w-0 max-w-full">
      {markdown ? (
        <div className="flex items-center gap-2">
          <span className="message-copy ml-auto">
            <CopyTextButton source={source} label="Copy message text" />
          </span>
        </div>
      ) : null}
      {markdown ? (
        <MarkdownContent
          source={source}
          identity={identity}
          revision={metadata.revision}
          generating={metadata.status === "generating"}
        />
      ) : renderArgs ? (
        renderArgs(args)
      ) : (
        <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap wrap-anywhere text-xs leading-5">
          {source}
        </pre>
      )}
      {metadata.status === "generating" && markdown && source.length > 0 ? (
        <GenerationIndicator state={{ status: "generating" }} />
      ) : null}
      {state.error ? (
        <div role="alert" className="text-sm text-danger">
          <p>{state.error.message}</p>
          <Button
            size="sm"
            disabled={state.loading}
            onClick={() => void resource.current?.refresh()}
          >
            Retry text
          </Button>
        </div>
      ) : saved?.text.has_more ? (
        <Button
          size="sm"
          aria-busy={state.loading}
          disabled={state.loading}
          onClick={() => void resource.current?.more()}
        >
          Load more text
        </Button>
      ) : null}
    </div>
  );
}
