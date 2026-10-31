import { Download, FileIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenuArea } from "@/components/ui/context-menu";
import { ImageViewer } from "@/components/ui/image-viewer";
import { Button, Spinner } from "@/components/ui/index";
import { Tooltip } from "@/components/ui/tooltip";
import type { ComposerFile } from "@/features/discussions/composer-state";
import { mediaGridBox, mediaSingleBox } from "@/features/inline-media";
import { type Attachment, backend } from "@/lib/backend";

export function fileSize(size: number) {
  return size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.ceil(size / 1024)} KiB`;
}

function FilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url && !failed ? (
    <img
      src={url}
      alt={file.name}
      onError={() => setFailed(true)}
      className="size-12 rounded object-cover"
    />
  ) : (
    <FileIcon className="size-8 flex-none" />
  );
}

export function ComposerAttachments({
  files,
  uploading = false,
  onRemove,
}: {
  files: ComposerFile[];
  uploading?: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <ul
      aria-label="Message attachments"
      className="m-0 flex max-h-40 list-none flex-wrap gap-2 overflow-y-auto p-3 pb-0"
    >
      {files.map((item) => (
        <li
          key={item.id}
          className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-line p-2"
        >
          <FilePreview file={item.file} />
          <div className="min-w-0 max-w-44">
            <div className="truncate text-xs" title={item.file.name}>
              {item.file.name}
            </div>
            <div className="text-xs opacity-60">
              {uploading ? "Uploading" : fileSize(item.file.size)}
            </div>
          </div>
          <button
            type="button"
            aria-label={`Remove ${item.file.name}`}
            className="flex size-6 flex-none items-center justify-center rounded hover:bg-white/10"
            onClick={() => onRemove(item.id)}
          >
            <X size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

type ImageAttachment = Attachment & { width: number; height: number };

function imageSize(image: ImageAttachment) {
  return { width: image.width, height: image.height };
}

export function MessageAttachments({
  discussionId,
  messageId,
  attachments,
}: {
  discussionId: number;
  messageId: number;
  attachments: Attachment[];
}) {
  const { images, files } = useMemo(() => {
    const pictures: ImageAttachment[] = [];
    const others: Attachment[] = [];
    for (const attachment of attachments) {
      if (attachment.width !== null && attachment.height !== null)
        pictures.push(attachment as ImageAttachment);
      else others.push(attachment);
    }
    return { images: pictures, files: others };
  }, [attachments]);
  return (
    <>
      {images.length === 0 ? null : (
        <AttachmentImages
          discussionId={discussionId}
          messageId={messageId}
          images={images}
        />
      )}
      {files.map((attachment) => (
        <MessageAttachment
          key={attachment.id}
          discussionId={discussionId}
          messageId={messageId}
          attachment={attachment}
        />
      ))}
    </>
  );
}

function AttachmentImages({
  discussionId,
  messageId,
  images,
}: {
  discussionId: number;
  messageId: number;
  images: ImageAttachment[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const created: string[] = [];
    const load = async (image: ImageAttachment) => {
      try {
        const blob = await backend.attachmentFile(
          discussionId,
          messageId,
          image,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        created.push(url);
        setSources((current) => ({ ...current, [image.id]: url }));
      } catch (failure) {
        if (abort.signal.aborted) return;
        setFailures((current) => ({
          ...current,
          [image.id]:
            failure instanceof Error ? failure.message : String(failure),
        }));
      }
    };
    for (const image of images) void load(image);
    return () => {
      abort.abort();
      for (const url of created) URL.revokeObjectURL(url);
      setSources({});
      setFailures({});
    };
  }, [discussionId, messageId, images, visible, attempt]);

  useEffect(
    () => () => {
      for (const [url, timer] of downloadUrls.current) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloadUrls.current.clear();
    },
    [],
  );

  const download = async (image: ImageAttachment) => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    const abort = new AbortController();
    try {
      const blob = await backend.attachmentFile(
        discussionId,
        messageId,
        image,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadUrls.current.delete(url);
      }, 30_000);
      downloadUrls.current.set(url, timer);
      const link = document.createElement("a");
      link.href = url;
      link.download = image.name;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (failure) {
      setDownloadError(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      setDownloading(false);
    }
  };

  const gallery = useMemo(
    () =>
      images.flatMap((image) => {
        const src = sources[image.id];
        return src === undefined ? [] : [{ image, src }];
      }),
    [images, sources],
  );
  const actions = (image: ImageAttachment) => [
    {
      id: "download",
      label: "Download",
      icon: <Download size={15} />,
      onSelect: () => void download(image),
    },
  ];
  const fail = (image: ImageAttachment, message: string) =>
    setFailures((current) => ({ ...current, [image.id]: message }));

  const single = images.length === 1 ? images[0] : null;
  const { columns, height } = mediaGridBox(images.length);
  const rows: ImageAttachment[][] = [];
  for (let index = 0; index < images.length; index += columns)
    rows.push(images.slice(index, index + columns));

  return (
    <div ref={root} className="attachment-images my-2">
      {single !== null ? (
        failures[single.id] !== undefined ? (
          <div
            className="inline-media inline-media-single inline-media-fixed"
            style={mediaSingleBox(imageSize(single))}
          >
            <div className="inline-media-failure">
              <p className="m-0 text-fg">{single.name}</p>
              <p role="alert" className="m-0 text-danger">
                {failures[single.id]}
              </p>
              <Button
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : sources[single.id] === undefined ? (
          <div
            className="inline-media inline-media-single inline-media-pending"
            style={mediaSingleBox(imageSize(single))}
          >
            <div className="inline-media-placeholder">
              <Spinner label="Loading image" />
              <span>Loading image…</span>
            </div>
          </div>
        ) : (
          <div
            className="inline-media inline-media-single"
            style={mediaSingleBox(imageSize(single))}
          >
            <Tooltip label={single.name}>
              <ContextMenuArea
                asChild
                label={`Actions for ${single.name}`}
                actions={actions(single)}
              >
                <button
                  type="button"
                  className="inline-media-open"
                  aria-label={`View ${single.name}`}
                  onClick={() => setOpen(single.id)}
                >
                  <img
                    src={sources[single.id]}
                    alt={single.name}
                    onError={() =>
                      fail(single, "The image could not be displayed.")
                    }
                  />
                </button>
              </ContextMenuArea>
            </Tooltip>
          </div>
        )
      ) : (
        <div className="inline-media inline-media-grid">
          {rows.map((row, rowIndex) => (
            <div
              key={rowIndex}
              className={`inline-media-row inline-media-row-${height}`}
            >
              {row.map((image) => (
                <Tooltip key={image.id} label={image.name}>
                  <ContextMenuArea
                    asChild
                    label={`Actions for ${image.name}`}
                    actions={actions(image)}
                  >
                    <button
                      type="button"
                      className="inline-media-cell inline-media-open"
                      aria-label={`View ${image.name}`}
                      onClick={() => setOpen(image.id)}
                    >
                      {sources[image.id] === undefined ? (
                        failures[image.id] === undefined ? (
                          <Spinner label="Loading image" />
                        ) : (
                          <span role="alert" className="text-xs text-danger">
                            {failures[image.id]}
                          </span>
                        )
                      ) : (
                        <img
                          src={sources[image.id]}
                          alt={image.name}
                          onError={() =>
                            fail(image, "The image could not be displayed.")
                          }
                        />
                      )}
                    </button>
                  </ContextMenuArea>
                </Tooltip>
              ))}
            </div>
          ))}
        </div>
      )}
      {downloadError === null ? null : (
        <div
          role="alert"
          className="flex items-center gap-2 pt-2 text-sm text-danger"
        >
          {downloadError}
          <Button
            size="sm"
            disabled={downloading}
            onClick={() => {
              const item = gallery[0];
              if (item) void download(item.image);
            }}
          >
            Retry download
          </Button>
        </div>
      )}
      {open === null ? null : (
        <ImageViewer
          open
          images={images.map((image) => ({
            src: `attachment:${image.id}`,
            name: image.name,
            alt: image.name,
            load: (signal: AbortSignal) =>
              backend.attachmentFile(discussionId, messageId, image, signal),
          }))}
          index={Math.max(
            0,
            images.findIndex((image) => image.id === open),
          )}
          onIndex={(next) => setOpen(images[next]?.id ?? null)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

export function MessageAttachment({
  discussionId,
  messageId,
  attachment,
}: {
  discussionId: number;
  messageId: number;
  attachment: Attachment;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const downloadUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      downloadRequest.current?.abort();
      for (const [objectUrl, timer] of downloadUrls.current) {
        clearTimeout(timer);
        URL.revokeObjectURL(objectUrl);
      }
      downloadUrls.current.clear();
    },
    [],
  );
  const download = async () => {
    if (downloadRequest.current) return;
    const abort = new AbortController();
    downloadRequest.current = abort;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await backend.attachmentFile(
        discussionId,
        messageId,
        attachment,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const timer = setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        downloadUrls.current.delete(objectUrl);
      }, 30_000);
      downloadUrls.current.set(objectUrl, timer);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.name;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (failure) {
      if (!abort.signal.aborted)
        setDownloadError(
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      downloadRequest.current = null;
      if (!abort.signal.aborted) setDownloading(false);
    }
  };

  return (
    <div
      ref={root}
      className="my-2 max-w-sm overflow-hidden rounded-lg border border-line bg-surface-raised"
    >
      <div className="flex items-center gap-2 p-3">
        <FileIcon size={20} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm" title={attachment.name}>
            {attachment.name}
          </div>
          <div className="text-xs text-fg-muted">
            {fileSize(attachment.size)}
          </div>
        </div>
        <Button
          size="sm"
          disabled={downloading}
          onClick={() => void download()}
          aria-label={`Download ${attachment.name}`}
        >
          <Download size={14} />
          Download
        </Button>
      </div>
      {downloadError === null ? null : (
        <div role="alert" className="px-3 pb-3 text-sm text-danger">
          {downloadError}
          <Button
            size="sm"
            disabled={downloading}
            onClick={() => void download()}
          >
            Retry download
          </Button>
        </div>
      )}
    </div>
  );
}
