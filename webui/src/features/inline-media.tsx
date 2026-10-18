import { clsx } from "clsx";
import { ChevronLeft, ChevronRight, FileVideo, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { documentPath, useNavigate } from "@/app/router";
import { Modal } from "@/components/ui/dialog";
import { Button, IconButton, Spinner } from "@/components/ui/index";
import { mediaKind } from "@/features/library/media";
import { libraryPathFromHref } from "@/features/library/path";
import { libraryEntry } from "@/features/library/preview";
import { backend } from "@/lib/backend";
import { documentName, formatBytes } from "@/lib/format";

const SYNTAX = /!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
export const VIDEO_LIMIT = 2;
const VIDEO_BYTES_LIMIT = 20 * 1024 * 1024;
const VIDEO_CACHE_LIMIT = 2;
const IMAGE_LIST_LIMIT = 9;
const SINGLE_WIDTH = 640;
const SINGLE_HEIGHT = 400;
const PLACEHOLDER_HEIGHT = 360;

const imageSizes = new Map<string, { width: number; height: number }>();
const videoObjects = new Map<string, string>();
const videoPlaying = new Set<string>();
const videoRequests = new Map<string, Promise<string>>();

export type InlineMediaKind = "image" | "video";

export type InlineMediaEntry = {
  path: string;
  alt: string;
  kind: InlineMediaKind;
  offset: number;
};

export function scanInlineMedia(source: string): InlineMediaEntry[] {
  const entries: InlineMediaEntry[] = [];
  for (const match of source.matchAll(SYNTAX)) {
    const path = libraryPathFromHref(match[2]);
    if (path === null) continue;
    const kind = mediaKind(path);
    if (kind !== "image" && kind !== "video") continue;
    entries.push({ path, alt: match[1], kind, offset: match.index ?? 0 });
  }
  return entries;
}

export function videoOrdinal(
  entries: InlineMediaEntry[],
  offset: number | null,
): number {
  if (offset === null) return 0;
  let ordinal = 0;
  for (const entry of entries) {
    if (entry.kind === "video" && entry.offset < offset) ordinal += 1;
  }
  return ordinal;
}

export function estimateInlineMediaSize(source: string): number {
  let total = 0;
  for (const block of source.split(/\n{2,}/)) {
    const entries = scanInlineMedia(block);
    if (entries.length === 0) continue;
    const images = entries.filter((entry) => entry.kind === "image").length;
    total += (entries.length - images) * (PLACEHOLDER_HEIGHT + 16);
    if (images === 0) continue;
    if (images === 1) total += PLACEHOLDER_HEIGHT + 16;
    else if (images === 2) total += 216;
    else if (images === 3) total += 136;
    else if (images === 4) total += 338;
    else {
      const rows = Math.ceil(Math.min(images, IMAGE_LIST_LIMIT) / 3);
      total += rows * 120 + (rows - 1) * 2 + 16;
    }
  }
  return total;
}

function mediaOffset(node: unknown): number | null {
  if (typeof node !== "object" || node === null) return null;
  const position = (node as { position?: { start?: { offset?: number } } })
    .position;
  const offset = position?.start?.offset;
  return typeof offset === "number" ? offset : null;
}

export { mediaOffset };

function evictVideoObjects(keep: string) {
  for (const [path, url] of [...videoObjects]) {
    if (videoObjects.size <= VIDEO_CACHE_LIMIT) return;
    if (path === keep || videoPlaying.has(path)) continue;
    URL.revokeObjectURL(url);
    videoObjects.delete(path);
  }
}

function releaseVideoUrl(path: string) {
  if (videoPlaying.has(path)) return;
  const url = videoObjects.get(path);
  if (url === undefined) return;
  URL.revokeObjectURL(url);
  videoObjects.delete(path);
}

function requestVideoUrl(path: string): Promise<string> {
  const cached = videoObjects.get(path);
  if (cached !== undefined) {
    videoObjects.delete(path);
    videoObjects.set(path, cached);
    return Promise.resolve(cached);
  }
  const pending = videoRequests.get(path);
  if (pending !== undefined) return pending;
  const request = backend
    .libraryFile(path, new AbortController().signal)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      videoObjects.set(path, url);
      evictVideoObjects(path);
      return url;
    })
    .finally(() => videoRequests.delete(path));
  videoRequests.set(path, request);
  return request;
}

async function rememberSize(
  path: string,
  url: string,
): Promise<{ width: number; height: number } | null> {
  if (typeof Image === "undefined") return null;
  const probe = new Image();
  probe.src = url;
  if (typeof probe.decode !== "function") return null;
  try {
    await probe.decode();
  } catch {
    return null;
  }
  if (probe.naturalWidth <= 0 || probe.naturalHeight <= 0) return null;
  const size = { width: probe.naturalWidth, height: probe.naturalHeight };
  imageSizes.set(path, size);
  return size;
}

function singleBox(size: { width: number; height: number } | null) {
  if (size === null) return undefined;
  const width = Math.min(
    SINGLE_WIDTH,
    Math.round((SINGLE_HEIGHT * size.width) / size.height),
  );
  return {
    width: `min(100%, ${width}px)`,
    aspectRatio: `${size.width} / ${size.height}`,
  };
}

function MediaFailure({
  alt,
  message,
  onRetry,
}: {
  alt: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="inline-media inline-media-fixed">
      <div className="inline-media-failure">
        {alt ? <p className="m-0 text-fg">{alt}</p> : null}
        <p role="alert" className="m-0 text-danger">
          {message}
        </p>
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function ImageViewer({
  gallery,
  index,
  onIndex,
  onClose,
}: {
  gallery: InlineMediaEntry[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const current = gallery[index];
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState<string | null>(null);

  useEffect(() => {
    if (current === undefined) return;
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void backend.libraryFile(current.path, abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => {
        if (!abort.signal.aborted) setFailed(true);
      },
    );
    return () => {
      abort.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [current]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (event.key === "ArrowRight" && index < gallery.length - 1)
        onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gallery.length, index, onIndex]);

  const download = async () => {
    if (current === undefined) return;
    setDownloading(true);
    setDownloadFailed(null);
    const abort = new AbortController();
    try {
      const blob = await backend.libraryFile(current.path, abort.signal);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = documentName(current.path);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (failure) {
      setDownloadFailed(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      setDownloading(false);
    }
  };

  if (current === undefined) return null;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={documentName(current.path)}
      variant="history"
      wide
      footer={
        <Button disabled={downloading} onClick={() => void download()}>
          Download original
        </Button>
      }
    >
      <div className="relative flex min-h-0 items-center justify-center">
        {failed ? (
          <p role="alert" className="m-0 text-danger">
            Image could not be loaded.
          </p>
        ) : url === null ? (
          <Spinner label="Loading image" />
        ) : (
          <img
            src={url}
            alt={current.alt}
            className="max-h-[65vh] w-full object-contain"
          />
        )}
        {index > 0 ? (
          <span className="absolute top-1/2 left-2 -translate-y-1/2">
            <IconButton
              label="Previous image"
              className="bg-surface/90"
              onClick={() => onIndex(index - 1)}
            >
              <ChevronLeft size={16} />
            </IconButton>
          </span>
        ) : null}
        {index < gallery.length - 1 ? (
          <span className="absolute top-1/2 right-2 -translate-y-1/2">
            <IconButton
              label="Next image"
              className="bg-surface/90"
              onClick={() => onIndex(index + 1)}
            >
              <ChevronRight size={16} />
            </IconButton>
          </span>
        ) : null}
      </div>
      {downloadFailed === null ? null : (
        <p role="alert" className="m-0 text-danger">
          {downloadFailed}
        </p>
      )}
    </Modal>
  );
}

function ImageCell({ path, alt }: { path: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    void backend.libraryFile(path, abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => undefined,
    );
    return () => {
      abort.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url === null ? null : (
    <img src={url} alt={alt} title={alt || undefined} />
  );
}

function openIndex(gallery: InlineMediaEntry[], offset: number | null) {
  if (offset === null) return 0;
  const found = gallery.findIndex((entry) => entry.offset === offset);
  return found < 0 ? 0 : found;
}

export function InlineMediaImage({
  path,
  alt,
  gallery,
  offset,
}: {
  path: string;
  alt: string;
  gallery: InlineMediaEntry[];
  offset: number | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState(() => imageSizes.get(path) ?? null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setFailed(false);
    setUrl(null);
    void backend.libraryFile(path, abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        const nextUrl = URL.createObjectURL(blob);
        objectUrl = nextUrl;
        setUrl(nextUrl);
        void rememberSize(path, nextUrl).then((next) => {
          if (next !== null && !abort.signal.aborted) setSize(next);
        });
      },
      () => {
        if (!abort.signal.aborted) setFailed(true);
      },
    );
    return () => {
      abort.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [path, attempt]);

  const label = alt || documentName(path);

  return (
    <>
      {failed ? (
        <MediaFailure
          alt={alt}
          message="Image could not be loaded."
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : url === null ? (
        <div
          className="inline-media inline-media-single inline-media-pending"
          style={singleBox(size)}
        >
          <div className="inline-media-placeholder">
            <Spinner label="Loading image" />
            <span>Loading image…</span>
          </div>
        </div>
      ) : (
        <div
          className="inline-media inline-media-single"
          style={singleBox(size)}
        >
          <button
            type="button"
            className="inline-media-open"
            aria-label={`View ${label}`}
            onClick={() => setOpen(openIndex(gallery, offset))}
          >
            <img src={url} alt={alt} title={alt || undefined} />
          </button>
        </div>
      )}
      {open === null ? null : (
        <ImageViewer
          gallery={gallery}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

export function InlineMediaVideo({ path, alt }: { path: string; alt: string }) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [entrySize, setEntrySize] = useState<number | null>(null);
  const [entryReady, setEntryReady] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const abort = new AbortController();
    setEntryReady(false);
    void libraryEntry(path).then(
      (entry) => {
        if (abort.signal.aborted) return;
        setEntrySize(entry?.size ?? null);
        setEntryReady(true);
      },
      () => {
        if (!abort.signal.aborted) setEntryReady(true);
      },
    );
    return () => abort.abort();
  }, [path]);

  useEffect(() => {
    const observer = new IntersectionObserver((records) =>
      setVisible(records.some((record) => record.isIntersecting)),
    );
    if (root.current !== null) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (visible || playing || url === null) return;
    setUrl(null);
    releaseVideoUrl(path);
  }, [visible, playing, url, path]);

  useEffect(
    () => () => {
      videoPlaying.delete(path);
      releaseVideoUrl(path);
    },
    [path],
  );

  const start = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await requestVideoUrl(path);
      setUrl(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const name = alt || documentName(path);

  if (entrySize !== null && entrySize > VIDEO_BYTES_LIMIT)
    return (
      <a
        href={documentPath(path)}
        className="inline-media-file"
        onClick={(event) => {
          event.preventDefault();
          navigate({ name: "library", path });
        }}
      >
        <FileVideo size={20} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm" title={name}>
            {name}
          </div>
          <div className="text-xs text-fg-muted">{formatBytes(entrySize)}</div>
        </div>
        <Play size={14} />
      </a>
    );

  if (failed)
    return (
      <MediaFailure
        alt={alt}
        message="Video could not be played."
        onRetry={() => void start()}
      />
    );

  return (
    <div ref={root} className="inline-media inline-media-video">
      {url === null ? (
        <div className="inline-media-placeholder">
          {visible && entryReady ? (
            <button
              type="button"
              className="inline-media-play"
              aria-label={`Play ${name}`}
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? <Spinner label="Loading video" /> : <Play size={22} />}
            </button>
          ) : null}
        </div>
      ) : (
        <video
          ref={video}
          className="inline-media-player"
          src={url}
          controls
          autoPlay
          playsInline
          preload="none"
          aria-label={name}
          onPlay={() => {
            videoPlaying.add(path);
            setPlaying(true);
          }}
          onPause={() => {
            videoPlaying.delete(path);
            setPlaying(false);
            if (!visible) {
              setUrl(null);
              releaseVideoUrl(path);
            }
          }}
          onEnded={() => {
            videoPlaying.delete(path);
            setPlaying(false);
          }}
          onError={() => {
            videoPlaying.delete(path);
            setPlaying(false);
            setUrl(null);
            releaseVideoUrl(path);
            setFailed(true);
          }}
        />
      )}
    </div>
  );
}

type GridItem = { path: string; alt: string; offset: number | null };

export function MediaGrid({
  items,
  gallery,
}: {
  items: GridItem[];
  gallery: InlineMediaEntry[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const total = items.length;
  const shown =
    total > IMAGE_LIST_LIMIT ? items.slice(0, IMAGE_LIST_LIMIT) : items;
  const columns = total === 2 ? 2 : total === 4 ? 2 : 3;
  const height = total === 2 ? 200 : total === 4 ? 160 : 120;
  const rows: GridItem[][] = [];
  for (let index = 0; index < shown.length; index += columns)
    rows.push(shown.slice(index, index + columns));
  const label = (item: GridItem) => item.alt || documentName(item.path);

  return (
    <>
      <div className="inline-media inline-media-grid">
        {rows.map((row, rowIndex) => (
          <div
            className={`inline-media-row inline-media-row-${height}`}
            key={rowIndex}
          >
            {row.map((item, cellIndex) => {
              const index = rowIndex * columns + cellIndex;
              const more =
                total > IMAGE_LIST_LIMIT && index === IMAGE_LIST_LIMIT - 1;
              return (
                <button
                  type="button"
                  key={`${item.path}:${index}`}
                  className={clsx(
                    "inline-media-cell inline-media-open",
                    more && "inline-media-more",
                  )}
                  aria-label={
                    more ? `View all ${total} images` : `View ${label(item)}`
                  }
                  onClick={() => setOpen(openIndex(gallery, item.offset))}
                >
                  <ImageCell path={item.path} alt={item.alt} />
                  {more ? (
                    <span className="inline-media-more-label">
                      +{total - IMAGE_LIST_LIMIT + 1}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {open === null ? null : (
        <ImageViewer
          gallery={gallery}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
