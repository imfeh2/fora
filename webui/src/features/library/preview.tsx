import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { documentPath, useNavigate } from "@/app/router";
import { mediaKind } from "@/features/library/media";
import { backend, type LibraryEntry } from "@/lib/backend";
import { documentName, formatBytes } from "@/lib/format";

const CARD_WIDTH = 360;
const CARD_GAP = 8;
const TEXT_BYTES = 32 * 1024;
const TEXT_LINES = 12;
const CACHE_LIMIT = 24;
const HOVER_DELAY = 250;
const LEAVE_DELAY = 120;

const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "text",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "csv",
  "log",
  "xml",
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rs",
  "go",
  "java",
  "sh",
  "sql",
]);

type PreviewKind = "image" | "video" | "audio" | "text" | "binary";

type PreviewData =
  | {
      status: "ready";
      kind: PreviewKind;
      size: number | null;
      url: string | null;
      text: string | null;
      truncated: boolean;
    }
  | { status: "failed" };

const cache = new Map<string, PreviewData>();
const ENTRY_REFRESH_MS = 5000;
let entries: LibraryEntry[] | null = null;
let entriesRequest: Promise<LibraryEntry[]> | null = null;
let entriesFetchedAt = 0;
let active: (() => void) | null = null;

export function previewKind(path: string): PreviewKind {
  const media = mediaKind(path);
  if (media !== null) return media;
  const name = documentName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1))) return "text";
  return "binary";
}

export function previewType(path: string): string {
  const name = documentName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "File";
  const extension = name.slice(dot + 1).toUpperCase();
  return extension === "PDF" ? "PDF document" : `${extension} file`;
}

export function previewText(text: string): string {
  const rows = text.split(/\r?\n/);
  const kept = rows.slice(0, TEXT_LINES);
  return kept.join("\n") + (rows.length > TEXT_LINES ? "\n…" : "");
}

function formatSeconds(value: number): string {
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function loadEntries(): Promise<LibraryEntry[]> {
  entriesRequest ??= backend.library().finally(() => {
    entriesRequest = null;
  });
  entries = await entriesRequest;
  entriesFetchedAt = Date.now();
  return entries;
}

async function lookupEntry(path: string): Promise<LibraryEntry | null> {
  const find = (list: LibraryEntry[]) =>
    list.find((entry) => entry.path === path) ?? null;
  if (entries === null) return find(await loadEntries());
  const found = find(entries);
  if (found !== null) return found;
  if (Date.now() - entriesFetchedAt < ENTRY_REFRESH_MS) return null;
  return find(await loadEntries());
}

function remember(path: string, data: PreviewData) {
  cache.set(path, data);
  if (cache.size <= CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest === undefined) return;
  const dropped = cache.get(oldest);
  if (dropped?.status === "ready" && dropped.url !== null)
    URL.revokeObjectURL(dropped.url);
  cache.delete(oldest);
}

async function fetchPreview(
  path: string,
  signal: AbortSignal,
): Promise<PreviewData> {
  const kind = previewKind(path);
  const entry = await lookupEntry(path);
  if (entry === null) return { status: "failed" };
  const size = entry.size;
  if (kind === "audio" || kind === "binary")
    return {
      status: "ready",
      kind,
      size,
      url: null,
      text: null,
      truncated: false,
    };
  const blob = await backend.libraryFile(path, signal);
  signal.throwIfAborted();
  if (kind === "text") {
    const raw = await blob.slice(0, TEXT_BYTES).text();
    return {
      status: "ready",
      kind,
      size: blob.size,
      url: null,
      text: previewText(raw),
      truncated: blob.size > TEXT_BYTES,
    };
  }
  return {
    status: "ready",
    kind,
    size: blob.size,
    url: URL.createObjectURL(blob),
    text: null,
    truncated: false,
  };
}

function claim(closer: () => void) {
  const previous = active;
  active = closer;
  if (previous !== null && previous !== closer) previous();
}

function release(closer: () => void) {
  if (active === closer) active = null;
}

function PreviewCard({
  path,
  anchor,
  card,
  onClose,
}: {
  path: string;
  anchor: DOMRect;
  card: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<PreviewData | null>(
    () => cache.get(path) ?? null,
  );
  const [height, setHeight] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    if (data !== null) return;
    const controller = new AbortController();
    let alive = true;
    void fetchPreview(path, controller.signal).then(
      (value) => {
        if (!alive || controller.signal.aborted) return;
        if (value.status === "ready") remember(path, value);
        setData(value);
      },
      () => {
        if (!alive || controller.signal.aborted) return;
        remember(path, { status: "failed" });
        setData({ status: "failed" });
      },
    );
    return () => {
      alive = false;
      controller.abort();
    };
  }, [path, data]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const close = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const element = card.current;
    if (element === null) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [card, data]);

  const above =
    anchor.bottom + CARD_GAP + height > window.innerHeight - CARD_GAP;
  const left = Math.min(
    Math.max(CARD_GAP, anchor.left),
    window.innerWidth - CARD_WIDTH - CARD_GAP,
  );
  const top = above
    ? Math.max(CARD_GAP, anchor.top - CARD_GAP - height)
    : anchor.bottom + CARD_GAP;

  const open = () => {
    onClose();
    navigate({ name: "document", path });
  };
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const element = card.current;
    if (element === null) return;
    const onCard = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("button"))
        return;
      openRef.current();
    };
    element.addEventListener("click", onCard);
    return () => element.removeEventListener("click", onCard);
  }, [card, data]);

  if (data?.status === "failed") return null;

  return createPortal(
    <div
      ref={card}
      role="dialog"
      aria-label={`Preview of ${documentName(path)}`}
      className="fixed z-(--layer-tooltip) flex flex-col overflow-hidden rounded-sm border border-line bg-surface-raised p-3 text-xs shadow-tooltip"
      style={{ left, top, width: CARD_WIDTH }}
      onMouseLeave={onClose}
    >
      {data === null ? (
        <span className="text-fg-muted">Loading preview…</span>
      ) : data.kind === "image" && data.url !== null ? (
        <img
          src={data.url}
          alt=""
          className="max-h-[240px] max-w-[320px] self-center rounded-xs object-contain"
        />
      ) : data.kind === "video" && data.url !== null ? (
        <div className="relative self-center">
          <video
            src={data.url}
            muted
            playsInline
            preload="metadata"
            className="max-h-[240px] max-w-[320px] rounded-xs object-contain"
            onLoadedMetadata={(event) => {
              const value = event.currentTarget.duration;
              if (Number.isFinite(value) && value > 0) setDuration(value);
            }}
          />
          {duration === null ? null : (
            <span className="absolute right-1 bottom-1 rounded-xs bg-app/80 px-1 py-0.5 text-[11px] tabular-nums text-fg">
              {formatSeconds(duration)}
            </span>
          )}
        </div>
      ) : data.kind === "text" && data.text !== null ? (
        <pre className="max-h-[220px] overflow-hidden font-mono text-[11px] leading-4 whitespace-pre-wrap wrap-anywhere text-fg-muted">
          {data.text}
        </pre>
      ) : (
        <span className="text-fg-muted">
          {previewType(path)}
          {data.status === "ready" && data.size !== null
            ? ` · ${formatBytes(data.size)}`
            : null}
        </span>
      )}
    </div>,
    document.body,
  );
}

export function LibraryLink({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const anchor = useRef<HTMLAnchorElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setRect(null);
  }, []);

  useEffect(() => {
    const closer = hide;
    return () => release(closer);
  }, [hide]);

  const show = () => {
    window.clearTimeout(timer.current);
    if (rect !== null || anchor.current === null) return;
    claim(hide);
    setRect(anchor.current.getBoundingClientRect());
  };

  const hideSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (anchor.current?.matches(":hover")) return;
      if (card.current?.matches(":hover")) return;
      hide();
      release(hide);
    }, LEAVE_DELAY);
  };

  return (
    <>
      <a
        ref={anchor}
        href={documentPath(path)}
        className="markdown-link"
        onMouseEnter={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(show, HOVER_DELAY);
        }}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            card.current?.contains(event.relatedTarget)
          )
            return;
          hide();
          release(hide);
        }}
        onClick={(event) => {
          event.preventDefault();
          hide();
          release(hide);
          navigate({ name: "document", path });
        }}
      >
        {children}
      </a>
      {rect !== null ? (
        <PreviewCard path={path} anchor={rect} card={card} onClose={hide} />
      ) : null}
    </>
  );
}
