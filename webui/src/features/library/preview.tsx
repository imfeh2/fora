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
import { Button } from "@/components/ui/index";
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
let entries: LibraryEntry[] | null = null;
let entriesRequest: Promise<LibraryEntry[]> | null = null;
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

async function lookupEntry(path: string): Promise<LibraryEntry | null> {
  if (entries === null) {
    entriesRequest ??= backend.library();
    try {
      entries = await entriesRequest;
    } finally {
      entriesRequest = null;
    }
  }
  return entries.find((entry) => entry.path === path) ?? null;
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
  const size = entry?.size ?? null;
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

  useEffect(() => {
    if (data !== null) return;
    const controller = new AbortController();
    let alive = true;
    void fetchPreview(path, controller.signal).then(
      (value) => {
        if (!alive || controller.signal.aborted) return;
        remember(path, value);
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

  if (data?.status === "failed") return null;

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

  return createPortal(
    <div
      ref={card}
      role="dialog"
      aria-label={`Preview of ${documentName(path)}`}
      className="fixed z-(--layer-tooltip) flex flex-col gap-2 overflow-hidden rounded-sm border border-line bg-surface-raised p-3 text-xs shadow-tooltip"
      style={{ left, top, width: CARD_WIDTH }}
      onMouseLeave={onClose}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-fg">
          {documentName(path)}
        </span>
        <span className="flex-none text-fg-muted tabular-nums">
          {data?.status === "ready" && data.size !== null
            ? formatBytes(data.size)
            : null}
        </span>
      </div>
      {data === null ? (
        <span className="text-fg-muted">Loading preview…</span>
      ) : data.kind === "image" && data.url !== null ? (
        <img
          src={data.url}
          alt=""
          className="max-h-[240px] max-w-[320px] self-center rounded-xs object-contain"
        />
      ) : data.kind === "video" && data.url !== null ? (
        <video
          src={data.url}
          muted
          playsInline
          preload="metadata"
          className="max-h-[240px] max-w-[320px] self-center rounded-xs object-contain"
        />
      ) : data.kind === "text" && data.text !== null ? (
        <pre className="max-h-[220px] overflow-hidden font-mono text-[11px] leading-4 whitespace-pre-wrap wrap-anywhere text-fg-muted">
          {data.text}
        </pre>
      ) : (
        <span className="text-fg-muted">{previewType(path)}</span>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => open()}>
          Open
        </Button>
      </div>
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
