import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import {
  BackendError,
  type DiscussionSummary,
  type Member,
} from "@/lib/backend";

export type Resource<T> =
  | { status: "pending"; data: null; error: null; refreshing: boolean }
  | { status: "failed"; data: null; error: BackendError; refreshing: false }
  | {
      status: "ready";
      data: T;
      error: BackendError | null;
      refreshing: boolean;
    };

export function useResource<T>(read: () => Promise<T>) {
  const [resource, setResource] = useState<Resource<T>>({
    status: "pending",
    data: null,
    error: null,
    refreshing: false,
  });
  const state = useRef(resource);
  const epoch = useRef(0);
  const active = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const publish = useCallback((next: Resource<T>) => {
    state.current = next;
    setResource(next);
  }, []);
  const invalidate = useCallback(
    (enabled: boolean, error?: BackendError) => {
      active.current = enabled;
      epoch.current += 1;
      pending.current = null;
      dirty.current = false;
      publish(
        !enabled && error && state.current.status !== "ready"
          ? { status: "failed", data: null, error, refreshing: false }
          : { ...state.current, refreshing: false },
      );
    },
    [publish],
  );
  const refresh = useCallback(
    (changed = false): Promise<void> => {
      if (!active.current) return Promise.resolve();
      if (pending.current) {
        if (changed) dirty.current = true;
        return pending.current;
      }
      const generation = epoch.current;
      const current = () => active.current && generation === epoch.current;
      publish(
        state.current.status !== "ready"
          ? { status: "pending", data: null, error: null, refreshing: true }
          : { ...state.current, refreshing: true },
      );
      const operation = Promise.resolve()
        .then(async () => {
          if (!current()) return;
          do {
            dirty.current = false;
            try {
              const data = await read();
              if (!current()) return;
              publish({ status: "ready", data, error: null, refreshing: true });
            } catch (failure) {
              if (!current()) return;
              const error =
                failure instanceof BackendError
                  ? failure
                  : new BackendError(
                      "request_failed",
                      failure instanceof Error
                        ? failure.message
                        : String(failure),
                    );
              publish(
                state.current.status !== "ready"
                  ? { status: "failed", data: null, error, refreshing: false }
                  : { ...state.current, error, refreshing: true },
              );
            }
          } while (current() && dirty.current);
        })
        .finally(() => {
          if (!current()) return;
          pending.current = null;
          publish({ ...state.current, refreshing: false });
        });
      pending.current = operation;
      return operation;
    },
    [read, publish],
  );
  return { resource, refresh, invalidate };
}

export type Organization = {
  members: Member[];
  humanId: number;
  discussions: DiscussionSummary[];
  refresh: () => Promise<void>;
};

const OrganizationContext = createContext<Organization | null>(null);

export function OrganizationProvider({
  value,
  children,
}: {
  value: Organization;
  children: ReactNode;
}) {
  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization(): Organization {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error("useOrganization used outside its provider");
  return value;
}
