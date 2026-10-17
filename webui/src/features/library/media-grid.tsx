import { FileText, Music, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";
import { mediaKind } from "@/features/library/media";
import { backend, type LibraryEntry } from "@/lib/backend";
import { documentName, formatBytes } from "@/lib/format";

function typeLabel(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return "File";
  return path.slice(dot + 1).toUpperCase();
}

function Thumbnail({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let object: string | null = null;
    void backend.libraryFile(path, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        object = URL.createObjectURL(blob);
        setUrl(object);
      },
      () => undefined,
    );
    return () => {
      controller.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [path]);
  const kind = mediaKind(path);
  if (url === null)
    return (
      <span className="flex h-full w-full items-center justify-center text-fg-muted">
        {kind === "video" ? <Play size={20} /> : <Music size={20} />}
      </span>
    );
  if (kind === "image")
    return <img src={url} alt="" className="h-full w-full object-cover" />;
  if (kind === "video")
    return (
      <video
        src={url}
        muted
        playsInline
        preload="metadata"
        className="h-full w-full object-cover"
      />
    );
  return (
    <span className="flex h-full w-full items-center justify-center text-fg-muted">
      <Music size={20} />
    </span>
  );
}

export function MediaGrid({
  entries,
  onOpen,
  rowActions,
}: {
  entries: LibraryEntry[];
  onOpen: (path: string) => void;
  rowActions?: (entry: LibraryEntry) => MenuAction[];
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
      {entries.map((entry) => (
        <li key={entry.path} className="group min-w-0">
          <div className="relative overflow-hidden rounded-md bg-surface-raised">
            <button
              type="button"
              className="block aspect-[4/3] w-full cursor-pointer border-0 bg-transparent p-0"
              aria-label={`Open ${entry.path}`}
              onClick={() => onOpen(entry.path)}
            >
              <Thumbnail path={entry.path} />
            </button>
            {rowActions ? (
              <span className="absolute top-1 right-1 inline-flex rounded-sm bg-app/80 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
                <OverflowMenu
                  label={`Actions for ${entry.path}`}
                  actions={rowActions(entry)}
                />
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="block w-full min-w-0 border-0 bg-transparent pt-2 text-left cursor-pointer"
            onClick={() => onOpen(entry.path)}
          >
            <span className="block truncate text-[13px] text-fg">
              {documentName(entry.path)}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              <FileText size={11} aria-hidden="true" />
              {typeLabel(entry.path)} · {formatBytes(entry.size)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
