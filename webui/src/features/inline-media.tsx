import { clsx } from "clsx";
import { FileVideo, FolderOpen, Play } from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { documentPath, useNavigate } from "@/app/router";
import { ContextMenuArea } from "@/components/ui/context-menu";
import { ImageViewer as SharedImageViewer } from "@/components/ui/image-viewer";
import { Button, Spinner } from "@/components/ui/index";
import { mediaKind } from "@/features/library/media";
import { libraryPathFromHref } from "@/features/library/path";
import { libraryEntry } from "@/features/library/preview";
import { backend } from "@/lib/backend";
import { documentName, formatBytes } from "@/lib/format";
import { MAX_FILE_BYTES } from "@/lib/limits";

const SYNTAX = /!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
export const VIDEO_LIMIT = 2;
const VIDEO_BYTES_LIMIT = MAX_FILE_BYTES;
const VIDEO_CACHE_LIMIT = 2;
const IMAGE_SIZE_LIMIT = 512;
const IMAGE_LIST_LIMIT = 9;
const SINGLE_WIDTH = 640;
const SINGLE_HEIGHT = 400;
const SINGLE_NARROW_HEIGHT = 320;
const PLACEHOLDER_HEIGHT = 360;

const imageSizes = new Map<string, { width: number; height: number }>();
const videoObjects = new Map<string, string>();
const videoHolders = new Map<string, number>();
const videoRequests = new Map<string, VideoRequest>();

export function rememberImageSize(
  path: string,
  size: { width: number; height: number },
) {
  imageSizes.delete(path);
  imageSizes.set(path, size);
  if (imageSizes.size <= IMAGE_SIZE_LIMIT) return;
  const oldest = imageSizes.keys().next().value;
  if (oldest !== undefined) imageSizes.delete(oldest);
}

export function imageSizeOf(path: string) {
  const size = imageSizes.get(path);
  if (size === undefined) return null;
  imageSizes.delete(path);
  imageSizes.set(path, size);
  return size;
}

type VideoRequest = {
  controller: AbortController;
  promise: Promise<string>;
};

export type VideoHold = {
  promise: Promise<string>;
  release: () => void;
};

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

function trimVideoObjects() {
  let unheld = 0;
  for (const path of videoObjects.keys())
    if ((videoHolders.get(path) ?? 0) === 0) unheld += 1;
  for (const [path, url] of [...videoObjects]) {
    if (unheld <= VIDEO_CACHE_LIMIT) return;
    if ((videoHolders.get(path) ?? 0) > 0) continue;
    URL.revokeObjectURL(url);
    videoObjects.delete(path);
    unheld -= 1;
  }
}

function touchVideo(path: string) {
  const url = videoObjects.get(path);
  if (url === undefined) return;
  videoObjects.delete(path);
  videoObjects.set(path, url);
}

function dropVideoHold(path: string) {
  const holders = (videoHolders.get(path) ?? 0) - 1;
  if (holders > 0) {
    videoHolders.set(path, holders);
    return;
  }
  videoHolders.delete(path);
  const pending = videoRequests.get(path);
  if (pending !== undefined) pending.controller.abort();
  trimVideoObjects();
}

function acquireVideoUrl(path: string): VideoHold {
  videoHolders.set(path, (videoHolders.get(path) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    dropVideoHold(path);
  };
  const cached = videoObjects.get(path);
  if (cached !== undefined) {
    touchVideo(path);
    return { promise: Promise.resolve(cached), release };
  }
  const pending = videoRequests.get(path);
  if (pending !== undefined) return { promise: pending.promise, release };
  const controller = new AbortController();
  const request: VideoRequest = { controller, promise: Promise.resolve("") };
  request.promise = backend
    .libraryFile(path, controller.signal)
    .then((blob) => {
      if (controller.signal.aborted || (videoHolders.get(path) ?? 0) === 0)
        throw new DOMException("Video request cancelled", "AbortError");
      const url = URL.createObjectURL(blob);
      videoObjects.set(path, url);
      trimVideoObjects();
      return url;
    })
    .finally(() => {
      if (videoRequests.get(path) === request) videoRequests.delete(path);
    });
  videoRequests.set(path, request);
  return { promise: request.promise, release };
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
  rememberImageSize(path, size);
  return size;
}

function singleBox(size: { width: number; height: number } | null) {
  if (size === null) return undefined;
  const wide = Math.min(
    SINGLE_WIDTH,
    Math.round((SINGLE_HEIGHT * size.width) / size.height),
  );
  const narrow = Math.round((SINGLE_NARROW_HEIGHT * size.width) / size.height);
  return {
    "--inline-single-width": `${wide}px`,
    "--inline-single-narrow-width": `${narrow}px`,
    aspectRatio: `${size.width} / ${size.height}`,
  } as CSSProperties;
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
  const images = useMemo(
    () =>
      gallery.map((entry) => ({
        src: entry.path,
        name: documentName(entry.path),
        alt: entry.alt,
        load: (signal: AbortSignal) => backend.libraryFile(entry.path, signal),
      })),
    [gallery],
  );
  return (
    <SharedImageViewer
      open
      images={images}
      index={index}
      onIndex={onIndex}
      onClose={onClose}
    />
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
  const [size, setSize] = useState(() => imageSizeOf(path));
  const [open, setOpen] = useState<number | null>(null);
  const navigate = useNavigate();

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
        <ContextMenuArea
          asChild
          label={`Actions for ${label}`}
          actions={[
            {
              id: "library",
              label: "Open in Library",
              icon: <FolderOpen size={15} />,
              onSelect: () => navigate({ name: "library", path }),
            },
          ]}
        >
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
              <img
                src={url}
                alt={alt}
                title={alt || undefined}
                onError={() => setFailed(true)}
              />
            </button>
          </div>
        </ContextMenuArea>
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
  const hold = useRef<VideoHold | null>(null);
  const [visible, setVisible] = useState(false);
  const [entrySize, setEntrySize] = useState<number | null>(null);
  const [entryVersion, setEntryVersion] = useState<string | null>(null);
  const [entryReady, setEntryReady] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
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
        setEntryVersion(
          entry === null ? null : `${entry.size}-${entry.modified_at}`,
        );
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
    if (!visible || !entryReady) return;
    let live = true;
    void backend.libraryPoster(path, entryVersion).then(
      (address) => {
        if (live) setPoster(address);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [visible, entryReady, path, entryVersion]);

  useEffect(() => {
    if (visible || playing || url === null) return;
    setUrl(null);
    hold.current?.release();
    hold.current = null;
  }, [visible, playing, url]);

  useEffect(
    () => () => {
      hold.current?.release();
      hold.current = null;
    },
    [],
  );

  const start = async () => {
    setBusy(true);
    setFailed(false);
    hold.current?.release();
    const next = acquireVideoUrl(path);
    hold.current = next;
    try {
      const objectUrl = await next.promise;
      if (hold.current === next) setUrl(objectUrl);
    } catch {
      if (hold.current === next) {
        hold.current = null;
        next.release();
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const name = alt || documentName(path);
  const present = visible && entryReady;

  if (entrySize !== null && entrySize > VIDEO_BYTES_LIMIT)
    return (
      <ContextMenuArea
        asChild
        label={`Actions for ${name}`}
        actions={[
          {
            id: "library",
            label: "Open in Library",
            icon: <FolderOpen size={15} />,
            onSelect: () => navigate({ name: "library", path }),
          },
        ]}
      >
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
            <div className="text-xs text-fg-muted">
              {formatBytes(entrySize)}
            </div>
          </div>
          <Play size={14} />
        </a>
      </ContextMenuArea>
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
          {present && poster !== null && !posterFailed ? (
            <div className="inline-media-poster">
              <img src={poster} alt="" onError={() => setPosterFailed(true)} />
            </div>
          ) : null}
          {present ? (
            <ContextMenuArea
              asChild
              label={`Actions for ${name}`}
              actions={[
                {
                  id: "library",
                  label: "Open in Library",
                  icon: <FolderOpen size={15} />,
                  onSelect: () => navigate({ name: "library", path }),
                },
              ]}
            >
              <button
                type="button"
                className="inline-media-play"
                aria-label={`Play ${name}`}
                disabled={busy}
                onClick={() => void start()}
              >
                {busy ? <Spinner label="Loading video" /> : <Play size={22} />}
              </button>
            </ContextMenuArea>
          ) : null}
        </div>
      ) : (
        <ContextMenuArea
          asChild
          label={`Actions for ${name}`}
          actions={[
            {
              id: "library",
              label: "Open in Library",
              icon: <FolderOpen size={15} />,
              onSelect: () => navigate({ name: "library", path }),
            },
          ]}
        >
          <video
            ref={video}
            className="inline-media-player"
            src={url}
            controls
            autoPlay
            playsInline
            preload="none"
            aria-label={name}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              if (!visible) {
                setUrl(null);
                hold.current?.release();
                hold.current = null;
              }
              trimVideoObjects();
            }}
            onEnded={() => {
              setPlaying(false);
              trimVideoObjects();
            }}
            onError={() => {
              setPlaying(false);
              setUrl(null);
              hold.current?.release();
              hold.current = null;
              setFailed(true);
            }}
          />
        </ContextMenuArea>
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
  const navigate = useNavigate();
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
                <ContextMenuArea
                  asChild
                  key={`${item.path}:${index}`}
                  label={`Actions for ${label(item)}`}
                  actions={[
                    {
                      id: "library",
                      label: "Open in Library",
                      icon: <FolderOpen size={15} />,
                      onSelect: () =>
                        navigate({ name: "library", path: item.path }),
                    },
                  ]}
                >
                  <button
                    type="button"
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
                </ContextMenuArea>
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
