import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export function clampColumnWidth(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export function readColumnWidth(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
): number {
  if (typeof window === "undefined") return initial;
  const stored = Number(window.localStorage.getItem(storageKey));
  return Number.isFinite(stored) && stored > 0
    ? clampColumnWidth(stored, min, max)
    : initial;
}

export function useColumnWidth({
  storageKey,
  initial,
  min,
  max,
  step = 16,
}: {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  step?: number;
}) {
  const [width, setWidth] = useState(() =>
    readColumnWidth(storageKey, initial, min, max),
  );
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const apply = useCallback(
    (next: number) => {
      const clamped = clampColumnWidth(next, min, max);
      widthRef.current = clamped;
      setWidth(clamped);
    },
    [max, min],
  );

  const persist = useCallback(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, String(widthRef.current));
  }, [storageKey]);

  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add("sidebar-resizing");
    return () => document.body.classList.remove("sidebar-resizing");
  }, [resizing]);

  const startResize = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = widthRef.current;
      setResizing(true);
      const move = (next: globalThis.PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        apply(startWidth + next.clientX - startX);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        window.removeEventListener("blur", stop);
        setResizing(false);
        persist();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("blur", stop);
    },
    [apply, persist],
  );

  const resizeWithKeys = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = widthRef.current - step;
      else if (event.key === "ArrowRight") next = widthRef.current + step;
      else if (event.key === "Home") next = min;
      else if (event.key === "End") next = max;
      if (next === null) return;
      event.preventDefault();
      apply(next);
      persist();
    },
    [apply, max, min, persist, step],
  );

  const reset = useCallback(() => {
    apply(initial);
    persist();
  }, [apply, initial, persist]);

  return { width, resizing, startResize, resizeWithKeys, reset };
}

export function ColumnResizeHandle({
  label,
  controls,
  min,
  max,
  width,
  resizing,
  className,
  style,
  onPointerDown,
  onKeyDown,
  onDoubleClick,
}: {
  label: string;
  controls?: string;
  min: number;
  max: number;
  width: number;
  resizing: boolean;
  className: string;
  style?: CSSProperties;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}) {
  return (
    <hr
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      data-resizing={resizing ? "true" : undefined}
      tabIndex={0}
      className={className}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
