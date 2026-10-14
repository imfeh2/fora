import {
  BackendError,
  type DiscussionPreviewRead,
  type GenerationTextPage,
} from "@/lib/backend";

export function validateGenerationText(
  page: GenerationTextPage,
  revision: number,
  offset: number,
): void {
  const length = new TextEncoder().encode(page.value).length;
  if (
    !Number.isSafeInteger(page.revision) ||
    !Number.isSafeInteger(page.offset) ||
    !Number.isSafeInteger(page.next_offset) ||
    !Number.isSafeInteger(page.total_bytes) ||
    page.revision < 1 ||
    page.offset < 0 ||
    page.revision !== revision ||
    page.offset !== offset ||
    page.next_offset !== offset + length ||
    page.next_offset > page.total_bytes ||
    page.total_bytes < 0 ||
    page.has_more !== page.next_offset < page.total_bytes ||
    (page.has_more && length === 0)
  )
    throw new BackendError(
      "generation_invalid",
      "Generation text page is invalid",
    );
}

export type GenerationSnapshot<T> = {
  metadata: T;
  text: GenerationTextPage;
};

export type GenerationResourceState<T> = {
  data: GenerationSnapshot<T> | null;
  loading: boolean;
  error: BackendError | null;
};

export class GenerationResource<T> {
  #state: GenerationResourceState<T> = {
    data: null,
    loading: false,
    error: null,
  };
  #epoch = 0;
  #closed = false;
  #paused = false;
  #wanted = 0;
  #dirty = false;
  #more = false;
  #extent = 0;
  #active: Promise<void> | null = null;
  #snapshot: () => Promise<GenerationSnapshot<T>>;
  #page: (
    data: GenerationSnapshot<T>,
    offset: number,
  ) => Promise<GenerationTextPage>;
  #revision: (metadata: T) => number;
  #publish: (state: GenerationResourceState<T>) => void;

  constructor(
    snapshot: () => Promise<GenerationSnapshot<T>>,
    page: (
      data: GenerationSnapshot<T>,
      offset: number,
    ) => Promise<GenerationTextPage>,
    revision: (metadata: T) => number,
    publish: (state: GenerationResourceState<T>) => void,
  ) {
    this.#snapshot = snapshot;
    this.#page = page;
    this.#revision = revision;
    this.#publish = publish;
  }

  get state(): GenerationResourceState<T> {
    return this.#state;
  }

  #commit(update: Partial<GenerationResourceState<T>>) {
    this.#state = { ...this.#state, ...update };
    this.#publish(this.#state);
  }

  refresh(revision = 0): Promise<void> {
    if (this.#closed || this.#paused) return Promise.resolve();
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Generation revision is invalid");
    this.#wanted = Math.max(this.#wanted, revision);
    if (revision > 0 && (this.#state.data?.text.revision ?? 0) >= revision)
      return this.#active ?? Promise.resolve();
    this.#dirty = true;
    return this.#run();
  }

  more(): Promise<void> {
    if (this.#active) return this.#active;
    if (this.#closed || this.#paused || !this.#state.data?.text.has_more)
      return Promise.resolve();
    this.#more = true;
    return this.#run();
  }

  async #append(saved: GenerationSnapshot<T>): Promise<GenerationSnapshot<T>> {
    const page = await this.#page(saved, saved.text.next_offset);
    validateGenerationText(page, saved.text.revision, saved.text.next_offset);
    if (page.total_bytes !== saved.text.total_bytes)
      throw new BackendError(
        "generation_invalid",
        "Generation text length changed within a revision",
      );
    return {
      metadata: saved.metadata,
      text: {
        ...page,
        offset: 0,
        value: saved.text.value + page.value,
      },
    };
  }

  #run(): Promise<void> {
    if (this.#active) return this.#active;
    const epoch = this.#epoch;
    const execute = async () => {
      while (
        !this.#closed &&
        !this.#paused &&
        epoch === this.#epoch &&
        (this.#dirty || this.#more)
      ) {
        const reload = this.#dirty || !this.#state.data;
        this.#dirty = false;
        const saved = this.#state.data;
        const wanted = this.#wanted;
        this.#commit({ loading: true });
        try {
          let next: GenerationSnapshot<T>;
          if (reload) {
            next = await this.#snapshot();
            validateGenerationText(next.text, this.#revision(next.metadata), 0);
            if (next.text.revision < wanted)
              throw new BackendError(
                "generation_invalid",
                "Generation snapshot is older than its committed revision",
              );
          } else {
            if (!saved) throw new Error("Generation snapshot is missing");
            if (!saved.text.has_more) {
              this.#more = false;
              continue;
            }
            next = await this.#append(saved);
          }
          if (this.#closed || this.#paused || epoch !== this.#epoch) return;
          const previous = this.#state.data;
          if (previous && next.text.revision < previous.text.revision)
            throw new BackendError(
              "generation_invalid",
              "Generation snapshot revision decreased",
            );
          if (
            reload &&
            previous?.text.revision === next.text.revision &&
            previous.text.next_offset > next.text.next_offset
          )
            next = { metadata: next.metadata, text: previous.text };
          while (next.text.has_more && next.text.next_offset < this.#extent) {
            next = await this.#append(next);
            if (this.#closed || this.#paused || epoch !== this.#epoch) return;
          }
          this.#extent = Math.max(this.#extent, next.text.next_offset);
          if (!reload || !next.text.has_more) this.#more = false;
          this.#commit({ data: next, error: null });
          if (next.text.revision < this.#wanted) this.#dirty = true;
        } catch (error) {
          if (this.#closed || this.#paused || epoch !== this.#epoch) return;
          const failure =
            error instanceof BackendError
              ? error
              : new BackendError(
                  "generation_failed",
                  error instanceof Error ? error.message : String(error),
                );
          if (failure.code === "generation_changed") {
            this.#dirty = true;
            continue;
          }
          this.#dirty = false;
          const removed = [
            "not_found",
            "not_a_member",
            "not_permitted",
            "permission_denied",
          ].includes(failure.code);
          if (removed) {
            this.#extent = 0;
            this.#more = false;
          }
          this.#commit({ error: failure, ...(removed ? { data: null } : {}) });
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

  pause(): void {
    if (this.#closed) return;
    this.#paused = true;
    this.#epoch += 1;
    this.#active = null;
    this.#commit({ loading: false });
  }

  resume(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#paused = false;
    return this.refresh();
  }

  dispose(): void {
    this.#closed = true;
    this.#epoch += 1;
    this.#active = null;
  }
}

export function previewSnapshot(read: DiscussionPreviewRead) {
  return { metadata: read.preview, text: read.body };
}
