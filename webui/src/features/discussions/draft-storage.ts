import { type DBSchema, type IDBPTransaction, openDB } from "idb";
import { v4 as uuidv4 } from "uuid";
import type { Draft } from "@/features/discussions/draft";

interface DraftDatabase extends DBSchema {
  drafts: { key: string; value: Draft };
}

export const draftDatabase = () =>
  openDB<DraftDatabase>("fora-drafts", 1, {
    upgrade(db) {
      db.createObjectStore("drafts", { keyPath: "key" });
    },
  });

export function emptyDraft(draft: Draft) {
  return (
    !draft.body &&
    draft.files.length === 0 &&
    draft.pending === null &&
    !draft.voiceSubmission
  );
}

export class DraftMovedError extends Error {
  constructor() {
    super("Draft moved to another tab. Reload to continue.");
  }
}

async function writeDraft<T>(
  operation: (
    transaction: IDBPTransaction<DraftDatabase, ["drafts"], "readwrite">,
  ) => Promise<T>,
): Promise<T> {
  const db = await draftDatabase();
  try {
    const transaction = db.transaction("drafts", "readwrite");
    const [result] = await Promise.all([
      operation(transaction),
      transaction.done,
    ]);
    return result;
  } finally {
    db.close();
  }
}

export class OwnedDraftStore {
  constructor(
    readonly key: string,
    readonly prefix: string,
    readonly owner: string,
  ) {}

  open(initial: Draft, create = true): Promise<Draft> {
    return writeDraft(async (transaction) => {
      const current = await transaction.store.get(this.key);
      if (current) {
        if (current.owner !== this.owner) throw new DraftMovedError();
        return current;
      }
      if (!create) throw new DraftMovedError();
      const created = {
        ...initial,
        owner: this.owner,
        storageRevision: uuidv4(),
      };
      await transaction.store.add(created);
      return created;
    });
  }

  async assertOwner() {
    const db = await draftDatabase();
    try {
      const current = await db.get("drafts", this.key);
      if (!current || current.owner !== this.owner) throw new DraftMovedError();
    } finally {
      db.close();
    }
  }

  save(draft: Draft): Promise<Draft> {
    const revision = uuidv4();
    return writeDraft(async (transaction) => {
      const current = await transaction.store.get(this.key);
      if (!current || current.owner !== this.owner) throw new DraftMovedError();
      const saved = {
        ...draft,
        key: this.key,
        owner: this.owner,
        storageRevision: revision,
      };
      await transaction.store.put(saved);
      return saved;
    });
  }

  candidates(): Promise<Draft[]> {
    return writeDraft(async (transaction) => {
      const originals = (await transaction.store.getAll()).filter(
        (draft) =>
          draft.key !== this.key &&
          draft.key.startsWith(this.prefix) &&
          !emptyDraft(draft),
      );
      const candidates = originals.map((draft) =>
        draft.storageRevision ? draft : { ...draft, storageRevision: uuidv4() },
      );
      for (let index = 0; index < originals.length; index++) {
        if (!originals[index].storageRevision)
          await transaction.store.put(candidates[index]);
      }
      return candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  recover(candidate: Draft, stillEmpty: () => boolean): Promise<Draft> {
    const revision = uuidv4();
    return writeDraft(async (transaction) => {
      const target = await transaction.store.get(this.key);
      const source = await transaction.store.get(candidate.key);
      if (!target || target.owner !== this.owner) throw new DraftMovedError();
      if (!emptyDraft(target) || !stillEmpty())
        throw new Error("The current draft is no longer empty.");
      if (!source)
        throw new Error("The saved draft has already moved. Choose again.");
      if (
        source.owner !== candidate.owner ||
        source.storageRevision !== candidate.storageRevision
      )
        throw new Error("The saved draft has changed. Choose again.");
      const recovered = {
        ...source,
        key: this.key,
        owner: this.owner,
        storageRevision: revision,
      };
      await transaction.store.put(recovered);
      await transaction.store.delete(candidate.key);
      return recovered;
    });
  }
}
