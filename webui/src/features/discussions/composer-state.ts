import { useMemo, useSyncExternalStore } from "react";
import { v4 as uuidv4 } from "uuid";
import { backend, type UploadRecord } from "@/lib/backend";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_BYTES,
  mib,
} from "@/lib/limits";

export type ComposerFile = {
  id: string;
  file: File;
  clientId: string;
  upload?: UploadRecord;
};

export type ComposerSubmission = {
  id: string;
  body: string;
  bodyRevision: number;
  files: ComposerFile[];
  phase: "uploading" | "sending";
};

export type ComposerDraft = {
  body: string;
  bodyRevision: number;
  files: ComposerFile[];
  pending: ComposerSubmission | null;
  voiceSubmission?: { id: string; submittedBody: string } | null;
};

export type ComposerView = {
  draft: ComposerDraft;
  busy: boolean;
  error: { message: string; kind: "rejected" | "send" } | null;
  submissionResult: { id: string; state: "sent" | "cancelled" } | null;
};

export type SendComposer = (
  body: string,
  attachments: string[],
  id: string,
) => Promise<boolean | "cancelled">;

export function pasteFiles(clipboard: {
  files: ArrayLike<File>;
  getData: (type: string) => string;
}): {
  files: File[];
  swallow: boolean;
} {
  const files = Array.from(clipboard.files);
  return {
    files,
    swallow: files.length > 0 && !clipboard.getData("text/plain"),
  };
}

export function fileProblem(
  file: File,
  existing: ComposerFile[],
): string | null {
  const images = ["image/png", "image/jpeg", "image/webp"];
  if (existing.length >= MAX_FILES)
    return `A message can contain at most ${MAX_FILES} files.`;
  if (file.size > MAX_FILE_BYTES)
    return `${file.name}: files must be at most ${mib(MAX_FILE_BYTES)} MiB.`;
  if (images.includes(file.type) && file.size > MAX_IMAGE_BYTES)
    return `${file.name}: images must be at most ${mib(MAX_IMAGE_BYTES)} MiB.`;
  if (
    existing.reduce((sum, item) => sum + item.file.size, file.size) >
    MAX_MESSAGE_BYTES
  )
    return `Message files must total at most ${mib(MAX_MESSAGE_BYTES)} MiB.`;
  if (
    !file.name.trim() ||
    file.name.length > 255 ||
    Array.from(file.name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return "Choose a filename of 1–255 characters without control characters.";
  return null;
}

export class ComposerController {
  #view: ComposerView;
  #listeners = new Set<() => void>();
  #abort: AbortController | null = null;

  constructor(readonly discussionId: number) {
    this.#view = {
      draft: { body: "", bodyRevision: 0, files: [], pending: null },
      busy: false,
      error: null,
      submissionResult: null,
    };
  }

  snapshot = () => this.#view;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #notify(update: Partial<ComposerView>) {
    this.#view = { ...this.#view, ...update };
    for (const listener of this.#listeners) listener();
  }

  #change(update: Partial<ComposerDraft>) {
    this.#notify({ draft: { ...this.#view.draft, ...update } });
  }

  setBody = (body: string) => {
    this.#change({ body, bodyRevision: this.#view.draft.bodyRevision + 1 });
  };

  setVoiceBody = (
    body: string,
    voiceSubmission: { id: string; submittedBody: string } | null,
  ) => {
    this.#change({
      body,
      bodyRevision: this.#view.draft.bodyRevision + 1,
      voiceSubmission,
    });
  };

  addFiles = (files: File[]) => {
    const accepted: ComposerFile[] = [];
    let problem: string | null = null;
    for (const file of files) {
      const reason = fileProblem(file, [
        ...this.#view.draft.files,
        ...accepted,
      ]);
      if (reason) {
        problem = reason;
        continue;
      }
      accepted.push({ id: uuidv4(), file, clientId: uuidv4() });
    }
    if (accepted.length)
      this.#change({ files: [...this.#view.draft.files, ...accepted] });
    if (problem)
      this.#notify({ error: { message: problem, kind: "rejected" } });
  };

  clearError = () => {
    if (this.#view.error !== null) this.#notify({ error: null });
  };

  removeFile = (id: string) => {
    const pending = this.#view.draft.pending;
    const remaining = this.#view.draft.files.filter((item) => item.id !== id);
    if (!pending) {
      this.#change({ files: remaining });
      return;
    }
    if (pending.phase === "sending") {
      void backend.cancelSend(this.discussionId, pending.id).catch(() => {});
      this.#abort?.abort();
      this.#notify({
        busy: false,
        draft: { ...this.#view.draft, files: remaining, pending: null },
        submissionResult: { id: pending.id, state: "cancelled" },
      });
      return;
    }
    this.#change({
      files: remaining,
      pending: {
        ...pending,
        files: pending.files.filter((item) => item.id !== id),
      },
    });
    this.#abort?.abort();
  };

  cancel = () => {
    this.#abort?.abort();
  };

  send = async (onSend: SendComposer) => {
    if (this.#view.busy) return;
    const draft = this.#view.draft;
    if (!draft.body.trim() && !draft.files.length) return;
    const submission: ComposerSubmission = {
      id: uuidv4(),
      body: draft.body.trim(),
      bodyRevision: draft.bodyRevision,
      files: draft.files.map((item) => ({ ...item })),
      phase: "uploading",
    };
    const abort = new AbortController();
    this.#abort = abort;
    this.#notify({
      busy: true,
      error: null,
      submissionResult: null,
      draft: { ...draft, pending: submission },
    });
    try {
      for (let index = 0; index < submission.files.length; index++) {
        abort.signal.throwIfAborted();
        let item = submission.files[index];
        let upload =
          item.upload ??
          (await backend.createUpload(
            this.discussionId,
            item.clientId,
            item.file,
          ));
        if (
          upload.state !== "reserved" ||
          upload.expires_at * 1000 <= Date.now()
        ) {
          const expired = upload;
          await backend.cancelUploads([expired.id]);
          abort.signal.throwIfAborted();
          item = { ...item, clientId: uuidv4() };
          upload = await backend.createUpload(
            this.discussionId,
            item.clientId,
            item.file,
          );
        }
        item = { ...item, upload };
        submission.files[index] = item;
        this.#change({ pending: { ...submission } });
        abort.signal.throwIfAborted();
        await backend.uploadFile(upload.id, item.file, abort.signal, () => {});
        submission.files[index] = {
          ...item,
          upload: { ...upload, state: "ready" },
        };
        this.#change({ pending: { ...submission } });
      }
      abort.signal.throwIfAborted();
      const sending: ComposerSubmission = { ...submission, phase: "sending" };
      this.#change({ pending: sending });
      const ids = sending.files.map((item) => {
        if (!item.upload) throw new Error("An uploaded file is missing its ID");
        return item.upload.id;
      });
      const result = await onSend(sending.body, ids, sending.id);
      abort.signal.throwIfAborted();
      if (result === "cancelled") {
        this.#notify({
          draft: {
            ...this.#view.draft,
            pending: null,
          },
          submissionResult: { id: sending.id, state: "cancelled" },
        });
        return;
      }
      if (!result) throw new Error("Send result is unconfirmed.");
      const current = this.#view.draft;
      const cleared = current.body.trim() === sending.body ? "" : current.body;
      const sent = new Set(sending.files.map((item) => item.id));
      this.#notify({
        draft: {
          ...current,
          body: cleared,
          bodyRevision:
            current.bodyRevision + (cleared === current.body ? 0 : 1),
          files: current.files.filter((item) => !sent.has(item.id)),
          pending: null,
        },
        submissionResult: { id: sending.id, state: "sent" },
      });
    } catch (error) {
      const uploads = submission.files.flatMap((item) =>
        item.upload ? [item.upload.id] : [],
      );
      if (abort.signal.aborted) {
        if (uploads.length)
          await backend.cancelUploads(uploads).catch(() => {});
        const current = this.#view.draft.pending;
        if (current?.phase === "sending" && current.id === submission.id)
          await backend
            .cancelSend(this.discussionId, submission.id)
            .catch(() => {});
        if (current === null || current?.id === submission.id)
          this.#notify({
            draft: { ...this.#view.draft, pending: null },
            submissionResult: { id: submission.id, state: "cancelled" },
          });
      } else {
        this.#notify({
          draft: { ...this.#view.draft, pending: null },
          error: {
            message: error instanceof Error ? error.message : String(error),
            kind: "send",
          },
        });
      }
    } finally {
      this.#abort = null;
      this.#notify({ busy: false });
    }
  };
}

export function useComposer(discussionId: number) {
  const controller = useMemo(
    () => new ComposerController(discussionId),
    [discussionId],
  );
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  return { controller, view };
}
