import { clsx } from "clsx";
import { Copy, FileVideo, FolderOpen, Play } from "lucide-react";
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
import { Button, IconButton, Spinner } from "@/components/ui/index";
import { mediaKind } from "@/features/library/media";
import { libraryPathFromHref } from "@/features/library/path";
import { libraryEntry } from "@/features/library/preview";
import { BackendError, backend } from "@/lib/backend";
import { copyText } from "@/lib/copy";
import { documentName, formatBytes } from "@/lib/format";
import { MAX_FILE_BYTES } from "@/lib/limits";

const SYNTAX = /!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
export const VIDEO_LIMIT = 2;
const VIDEO_BYTES_LIMIT = MAX_FILE_BYTES;
const VIDEO_CACHE_LIMIT = 2;
const IMAGE_CACHE_LIMIT = 24;
const IMAGE_LIST_LIMIT = 9;
const SINGLE_WIDTH = 640;
const SINGLE_HEIGHT = 400;
const SINGLE_NARROW_HEIGHT = 320;
const PLACEHOLDER_HEIGHT = 360;

const imageObjects = new Map<string, string>();
const videoObjects = new Map<string, string>();
const videoHolders = new Map<string, number>();
const videoRequests = new Map<string, VideoRequest>();

function dropImage(path: string) {
  const url = imageObjects.get(path);
  imageObjects.delete(path);
  if (url !== undefined) URL.revokeObjectURL(url);
}

function touchImage(path: string) {
  const url = imageObjects.get(path);
  if (url === undefined) return;
  imageObjects.delete(path);
  imageObjects.set(path, url);
}

function takeImage(path: string) {
  const url = imageObjects.get(path);
  if (url === undefined) return null;
  touchImage(path);
  return url;
}

function cacheImage(path: string, url: string) {
  dropImage(path);
  imageObjects.set(path, url);
  while (imageObjects.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageObjects.keys().next().value;
    if (oldest === undefined) break;
    dropImage(oldest);
  }
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

async function decodeSize(
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
  return { width: probe.naturalWidth, height: probe.naturalHeight };
}

export function mediaSingleBox(size: { width: number; height: number } | null) {
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

export function mediaGridBox(total: number) {
  return {
    columns: total === 2 ? 2 : total === 4 ? 2 : 3,
    height: total === 2 ? 200 : total === 4 ? 160 : 120,
  };
}

function fileFailure(error: unknown): string {
  if (error instanceof BackendError && error.details !== null)
    return error.details;
  return [
    "Stage: File request",
    `Error: ${error instanceof Error ? error.name : "Unknown"}`,
    `Message: ${error instanceof Error ? error.message : String(error)}`,
  ].join("\n");
}

function MediaFailure({
  path,
  alt,
  message,
  details,
  busy,
  onRetry,
}: {
  path: string;
  alt: string;
  message: string;
  details: string;
  busy: boolean;
  onRetry: () => void;
}) {
  const [address, setAddress] = useState("Unavailable");
  useEffect(() => {
    let live = true;
    void backend.libraryFileUrl(path).then(
      (value) => {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        if (live) setAddress(url.toString());
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [path]);
  const diagnostic = [
    details,
    `File: ${path}`,
    `File URL: ${address}`,
    `Page origin: ${location.origin}`,
  ].join("\n");
  useEffect(() => {
    console.error("Inline media failed", diagnostic);
  }, [diagnostic]);
  return (
    <div className="inline-media inline-media-fixed">
      <div className="inline-media-failure">
        {alt ? <p className="m-0 text-fg">{alt}</p> : null}
        <p role="alert" className="m-0 text-danger">
          {message}
        </p>
        <Button size="sm" disabled={busy} onClick={onRetry}>
          Retry
        </Button>
        <details className="w-full min-w-0">
          <summary className="cursor-pointer text-fg-muted">Details</summary>
          <IconButton
            label="Copy error details"
            onClick={() =>
              void copyText(diagnostic).catch(backend.reportFailure)
            }
          >
            <Copy size={14} />
          </IconButton>
          <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all select-text font-mono text-xs text-fg-muted">
            {diagnostic}
          </pre>
        </details>
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
    void (async () => {
      try {
        const blob = await backend.libraryFile(path, abort.signal);
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        const next = await decodeSize(objectUrl);
        if (abort.signal.aborted || next === null) return;
        setUrl(objectUrl);
      } catch {
        return;
      }
    })();
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
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cached, setCached] = useState(() => takeImage(path) !== null);
  const [size, setSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const abort = new AbortController();
    let created: string | null = null;
    setBusy(true);
    const show = (source: string, next: { width: number; height: number }) => {
      if (abort.signal.aborted) return;
      setSize(next);
      setUrl(source);
      setFailure(null);
      setBusy(false);
    };
    const fail = (details: string) => {
      if (abort.signal.aborted) return;
      setFailure(details);
      setBusy(false);
    };
    const cached = takeImage(path);
    setCached(cached !== null);
    if (cached !== null) {
      void decodeSize(cached).then((next) => {
        if (next === null) {
          dropImage(path);
          fail(
            "Stage: Image decoding\nMessage: The image could not be decoded.",
          );
          return;
        }
        show(cached, next);
      });
      return () => abort.abort();
    }
    void (async () => {
      try {
        const blob = await backend.libraryFile(path, abort.signal);
        if (abort.signal.aborted) return;
        created = URL.createObjectURL(blob);
        const next = await decodeSize(created);
        if (abort.signal.aborted) {
          URL.revokeObjectURL(created);
          created = null;
          return;
        }
        if (next === null) {
          URL.revokeObjectURL(created);
          created = null;
          fail(
            "Stage: Image decoding\nMessage: The image could not be decoded.",
          );
          return;
        }
        const source = created;
        cacheImage(path, source);
        created = null;
        show(source, next);
      } catch (error) {
        if (!abort.signal.aborted) fail(fileFailure(error));
      }
    })();
    return () => {
      abort.abort();
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [path, attempt]);

  const label = alt || documentName(path);

  return (
    <>
      {failure !== null ? (
        <MediaFailure
          path={path}
          alt={alt}
          message="Image could not be loaded."
          details={failure}
          busy={busy}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : url === null || size === null ? (
        cached ? null : (
          <div className="inline-media inline-media-pending" />
        )
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
            style={mediaSingleBox(size)}
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
                onError={(event) =>
                  setFailure(
                    `Stage: Image decoding\nSource: ${event.currentTarget.currentSrc || url}\nMessage: The browser could not decode the downloaded image.`,
                  )
                }
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
  const ready = useRef<Promise<void>>(Promise.resolve());
  const entryBytes = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [entrySize, setEntrySize] = useState<number | null>(null);
  const [entryVersion, setEntryVersion] = useState<string | null>(null);
  const [entryReady, setEntryReady] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const abort = new AbortController();
    let release = () => {};
    ready.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    setEntryReady(false);
    void libraryEntry(path).then(
      (entry) => {
        if (abort.signal.aborted) return;
        entryBytes.current = entry?.size ?? null;
        setEntrySize(entry?.size ?? null);
        setEntryVersion(
          entry === null ? null : `${entry.size}-${entry.modified_at}`,
        );
        setEntryReady(true);
        release();
      },
      () => {
        if (!abort.signal.aborted) setEntryReady(true);
        release();
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
    hold.current?.release();
    hold.current = null;
    await ready.current;
    const bytes = entryBytes.current;
    if (bytes !== null && bytes > VIDEO_BYTES_LIMIT) {
      setBusy(false);
      return;
    }
    const next = acquireVideoUrl(path);
    hold.current = next;
    try {
      const objectUrl = await next.promise;
      if (hold.current === next) {
        setFailure(null);
        setUrl(objectUrl);
      }
    } catch (error) {
      if (hold.current === next) {
        hold.current = null;
        next.release();
        setFailure(fileFailure(error));
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

  if (failure !== null)
    return (
      <MediaFailure
        path={path}
        alt={alt}
        message="Video could not be played."
        details={failure}
        busy={busy}
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
            onError={(event) => {
              const player = event.currentTarget;
              setFailure(
                [
                  "Stage: Video playback",
                  `MediaError.code: ${player.error?.code ?? "Unavailable"}`,
                  `Message: ${player.error?.message || "The browser could not play the downloaded video."}`,
                  `Source: ${player.currentSrc || url}`,
                  `Ready state: ${player.readyState}`,
                  `Network state: ${player.networkState}`,
                ].join("\n"),
              );
              setPlaying(false);
              setUrl(null);
              hold.current?.release();
              hold.current = null;
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
  const { columns, height } = mediaGridBox(total);
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
