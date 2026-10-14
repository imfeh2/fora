import {
  createContext,
  type SetStateAction,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type WindowPosition = {
  identity: string;
  path: number[];
  top: number;
  scrollTop: number;
};

export type WindowCache = {
  values: Map<string, unknown>;
  following: boolean;
  position: WindowPosition | null;
};

export const WindowContext = createContext<WindowCache | null>(null);

export function useWindowCache() {
  return useContext(WindowContext);
}

export function useWindowState<T>(
  key: string,
  initial: T | (() => T),
): [T, (value: SetStateAction<T>) => void] {
  const cache = useWindowCache();
  const [value, update] = useState<T>(() => {
    if (cache?.values.has(key)) return cache.values.get(key) as T;
    const value =
      typeof initial === "function" ? (initial as () => T)() : initial;
    cache?.values.set(key, value);
    return value;
  });
  const current = useRef(value);
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const value =
        typeof next === "function"
          ? (next as (value: T) => T)(current.current)
          : next;
      current.current = value;
      cache?.values.set(key, value);
      update(value);
    },
    [cache, key],
  );
  return [value, setValue];
}
