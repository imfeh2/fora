import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadMessage } from "@/features/discussions/thread-data";
import {
  GenerationResource,
  type GenerationResourceState,
  previewSnapshot,
} from "@/features/generation-resource";
import {
  BackendError,
  type BackendEvent,
  backend,
  type DiscussionPreview,
} from "@/lib/backend";

export type PreviewState = GenerationResourceState<DiscussionPreview>;
export type PreviewDirectory = {
  metadata: Record<string, DiscussionPreview>;
  resources: Record<string, PreviewState>;
  aliases: Record<number, string>;
  loading: boolean;
  error: BackendError | null;
  before: [string, string] | null;
};

export type ThreadUnit = {
  key: string;
  senderId: number;
  timestamp: string;
  message?: ThreadMessage;
  preview?: PreviewState;
};

export function combineThreadUnits(
  messages: ThreadMessage[],
  cache?: Map<string, ThreadUnit>,
): ThreadUnit[] {
  return messages.map((message) => {
    const key = `message:${message.id}`;
    const cached = cache?.get(key);
    if (cached && cached.message === message) return cached;
    const unit = {
      key,
      timestamp: message.created_at,
      senderId: message.sender_id,
      message,
    };
    cache?.set(key, unit);
    return unit;
  });
}

export class DiscussionPreviewReader {
  #state: PreviewDirectory = {
    metadata: {},
    resources: {},
    aliases: {},
    loading: false,
    error: null,
    before: null,
  };
  #id: number;
  #publish: (state: PreviewDirectory) => void;
  #resources = new Map<string, GenerationResource<DiscussionPreview>>();
  #off: (() => void) | null = null;
  #epoch = 0;
  #live = false;
  #paused = false;
  #active: Promise<void> | null = null;
  #dirty = false;
  #loaded = false;

  constructor(id: number, publish: (state: PreviewDirectory) => void) {
    this.#id = id;
    this.#publish = publish;
  }

  get state() {
    return this.#state;
  }

  #commit(update: Partial<PreviewDirectory>) {
    this.#state = { ...this.#state, ...update };
    this.#publish(this.#state);
  }

  #metadata(preview: DiscussionPreview) {
    if (preview.discussion_id !== this.#id)
      throw new Error("Preview belongs to another Discussion");
    const previous = this.#state.metadata[preview.preview_id];
    if (previous && previous.revision > preview.revision) return;
    if (previous?.status === "sent" && preview.status !== "sent") return;
    this.#commit({
      metadata: { ...this.#state.metadata, [preview.preview_id]: preview },
      aliases:
        preview.message_id === null
          ? this.#state.aliases
          : {
              ...this.#state.aliases,
              [preview.message_id]: preview.preview_id,
            },
    });
  }

  #resource(id: string) {
    const known = this.#resources.get(id);
    if (known) return known;
    const resource = new GenerationResource<DiscussionPreview>(
      async () => {
        const read = await backend.discussionPreview(this.#id, id);
        if (
          read.preview.preview_id !== id ||
          read.preview.discussion_id !== this.#id
        )
          throw new Error("Preview resource identity changed");
        return previewSnapshot(read);
      },
      (saved, offset) =>
        backend.discussionPreviewText(
          this.#id,
          id,
          saved.text.revision,
          offset,
        ),
      (metadata) => metadata.revision,
      (state) => {
        if (!this.#live) return;
        if (state.data) this.#metadata(state.data.metadata);
        this.#commit({ resources: { ...this.#state.resources, [id]: state } });
      },
    );
    this.#resources.set(id, resource);
    return resource;
  }

  start(): Promise<void> {
    if (this.#live) throw new Error("Preview reader is already active");
    this.#live = true;
    this.#off = backend.onEvent((event) => this.#event(event));
    return this.refresh();
  }

  #event(event: BackendEvent) {
    if (event.type === "connection.closed") {
      this.#paused = true;
      this.#epoch += 1;
      this.#active = null;
      for (const resource of this.#resources.values()) resource.pause();
      this.#commit({ loading: false });
      return;
    }
    if (event.type === "connection.restored") {
      this.#paused = false;
      for (const resource of this.#resources.values()) void resource.resume();
      void this.refresh();
      return;
    }
    if (this.#paused) return;
    if (event.type === "member.deleted") {
      for (const resource of this.#resources.values()) void resource.refresh();
      void this.refresh();
      return;
    }
    if (
      event.discussion_id !== this.#id &&
      !(event.type === "discussion.updated" && event.id === this.#id)
    )
      return;
    if (
      event.type === "message.created" &&
      typeof event.id === "number" &&
      typeof event.preview_id === "string"
    )
      this.#commit({
        aliases: { ...this.#state.aliases, [event.id]: event.preview_id },
      });
    if (
      (event.type === "discussion.preview" ||
        event.type === "message.created") &&
      typeof event.preview_id === "string" &&
      typeof event.revision === "number"
    )
      void this.#resource(event.preview_id).refresh(event.revision);
    if (event.type === "discussion.updated") {
      for (const resource of this.#resources.values()) void resource.refresh();
      void this.refresh();
    }
  }

  refresh(): Promise<void> {
    if (!this.#live || this.#paused) return Promise.resolve();
    this.#dirty = true;
    return this.#directory();
  }

  earlier(): Promise<void> {
    if (!this.#live || this.#paused || !this.#state.before)
      return Promise.resolve();
    return this.#directory(this.#state.before);
  }

  #directory(before?: [string, string]): Promise<void> {
    if (this.#active) return this.#active;
    const epoch = this.#epoch;
    const execute = async () => {
      let cursor = before;
      do {
        this.#dirty = false;
        this.#commit({ loading: true });
        try {
          const page = await backend.discussionPreviews(this.#id, cursor, 50);
          if (!this.#live || this.#paused || epoch !== this.#epoch) return;
          if (
            page.discussion_id !== this.#id ||
            page.has_more !== (page.next_before !== null)
          )
            throw new Error("Preview directory identity or cursor is invalid");
          for (const preview of page.previews) {
            this.#metadata(preview);
            if (
              preview.status !== "sent" ||
              this.#resources.has(preview.preview_id)
            )
              void this.#resource(preview.preview_id).refresh(preview.revision);
          }
          this.#commit({
            error: null,
            before:
              cursor || !this.#loaded ? page.next_before : this.#state.before,
          });
          this.#loaded = true;
          cursor = undefined;
        } catch (error) {
          if (!this.#live || this.#paused || epoch !== this.#epoch) return;
          const failure =
            error instanceof BackendError
              ? error
              : new BackendError(
                  "generation_failed",
                  error instanceof Error ? error.message : String(error),
                );
          if (
            [
              "not_a_member",
              "not_permitted",
              "permission_denied",
              "not_found",
            ].includes(failure.code)
          ) {
            for (const resource of this.#resources.values()) resource.dispose();
            this.#resources.clear();
            this.#commit({
              metadata: {},
              resources: {},
              aliases: {},
              before: null,
            });
          }
          this.#commit({ error: failure });
          return;
        }
      } while (this.#dirty);
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

  more(id: string) {
    return this.#resource(id).more();
  }
  retry(id: string) {
    return this.#resource(id).refresh();
  }

  dispose(): void {
    this.#live = false;
    this.#epoch += 1;
    this.#off?.();
    this.#off = null;
    for (const resource of this.#resources.values()) resource.dispose();
    this.#resources.clear();
  }
}

export function useDiscussionPreviews(id: number) {
  const reader = useRef<DiscussionPreviewReader | null>(null);
  const [state, setState] = useState<PreviewDirectory>({
    metadata: {},
    resources: {},
    aliases: {},
    loading: false,
    error: null,
    before: null,
  });
  useEffect(() => {
    const current = new DiscussionPreviewReader(id, setState);
    reader.current = current;
    void current.start();
    return () => {
      current.dispose();
      if (reader.current === current) reader.current = null;
    };
  }, [id]);
  const more = useCallback(
    (previewId: string) => reader.current?.more(previewId),
    [],
  );
  const retry = useCallback(
    (previewId: string) => reader.current?.retry(previewId),
    [],
  );
  const earlier = useCallback(() => reader.current?.earlier(), []);
  const refresh = useCallback(() => reader.current?.refresh(), []);
  return { state, more, retry, earlier, refresh };
}
