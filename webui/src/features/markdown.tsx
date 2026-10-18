import { createCodePlugin } from "@streamdown/code";
import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";
import {
  Children,
  isValidElement,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import {
  CodeBlock,
  type Components,
  defaultRemarkPlugins,
  defaultUrlTransform,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { toast } from "@/components/ui/toast";
import {
  type InlineMediaEntry,
  InlineMediaImage,
  InlineMediaVideo,
  MediaGrid,
  mediaOffset,
  scanInlineMedia,
  VIDEO_LIMIT,
  videoOrdinal,
} from "@/features/inline-media";
import { mediaKind } from "@/features/library/media";
import { libraryPathFromHref } from "@/features/library/path";
import { LibraryLink } from "@/features/library/preview";
import { remarkLiteralHtml, remarkMentions } from "@/features/markdown-plugins";
import type { MessageMention } from "@/lib/backend";
import { copyText } from "@/lib/copy";
import { documentName } from "@/lib/format";

const plugins = {
  code: createCodePlugin({ themes: ["github-dark", "github-dark"] }),
};
const noMentions: MessageMention[] = [];

export function CopyTextButton({
  source,
  label = "Copy code",
  touchTarget = false,
}: {
  source: string;
  label?: string;
  touchTarget?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setCopied(false);
    setBusy(false);
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
    };
  }, [source]);
  const copy = async () => {
    const current = generation.current;
    setBusy(true);
    try {
      await copyText(source);
      if (current !== generation.current) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch (failure) {
      if (current === generation.current)
        toast({
          tone: "danger",
          title: "Could not copy",
          description:
            failure instanceof Error ? failure.message : String(failure),
        });
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={clsx(
        "markdown-copy inline-flex size-7 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer",
        touchTarget && "touch:size-11 touch:min-w-11 touch:min-h-11",
      )}
      aria-label={copied ? "Copied" : label}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
    >
      {copied ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );
}

export { libraryPathFromHref };

function keepsHref(href: string): boolean {
  try {
    const protocol = new URL(href, "http://localhost/").protocol;
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

type ImageProps = {
  src?: string;
  alt?: string;
  node?: { position?: { start?: { offset?: number } } };
};

function imageElement({ src, alt, node }: ImageProps) {
  const href =
    typeof src === "string" && node
      ? defaultUrlTransform(src, "src", node as never)
      : undefined;
  if (href && keepsHref(href))
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-link"
      >
        {alt || src}
      </a>
    );
  return alt ? <span>{alt}</span> : null;
}

const baseComponents: Components = {
  code: ({ children, className, node: _node, ...props }) => {
    if (!("data-block" in props))
      return (
        <code className="rounded-xs bg-surface px-1 font-mono text-[0.9em]">
          {children}
        </code>
      );
    const value = String(children ?? "");
    const source = value.endsWith("\n") ? value.slice(0, -1) : value;
    const language = className?.startsWith("language-")
      ? className.slice(9)
      : "";
    return (
      <CodeBlock code={source} language={language} lineNumbers={false}>
        <CopyTextButton source={source} />
      </CodeBlock>
    );
  },
  a: ({ children, href, node: _node }) => {
    const path = href ? libraryPathFromHref(href) : null;
    if (path !== null) return <LibraryLink path={path}>{children}</LibraryLink>;
    return href && keepsHref(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-link"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: imageElement,
};

function inlineComponents(
  media: InlineMediaEntry[],
  gallery: InlineMediaEntry[],
): Components {
  const resolveProps = ({
    src,
    alt,
    node,
  }: ImageProps): InlineMediaEntry | null => {
    const href =
      typeof src === "string" && node
        ? defaultUrlTransform(src, "src", node as never)
        : undefined;
    const path = href ? libraryPathFromHref(href) : null;
    const kind = path === null ? null : mediaKind(path);
    if (path === null || (kind !== "image" && kind !== "video")) return null;
    return { path, alt: alt ?? "", kind, offset: mediaOffset(node) ?? 0 };
  };

  const resolveMedia = (child: ReactNode): InlineMediaEntry | null => {
    if (!isValidElement(child) || child.type !== Image) return null;
    return resolveProps(child.props as ImageProps);
  };

  function Image({ src, alt, node }: ImageProps) {
    const entry = resolveProps({ src, alt, node });
    if (entry === null) return imageElement({ src, alt, node });
    if (entry.kind === "image")
      return (
        <InlineMediaImage
          path={entry.path}
          alt={entry.alt}
          gallery={gallery}
          offset={mediaOffset(node)}
        />
      );
    if (videoOrdinal(media, mediaOffset(node)) < VIDEO_LIMIT)
      return <InlineMediaVideo path={entry.path} alt={entry.alt} />;
    return (
      <LibraryLink path={entry.path}>
        {entry.alt || documentName(entry.path)}
      </LibraryLink>
    );
  }

  return {
    ...baseComponents,
    img: Image,
    p: ({ children }) => {
      const items = Children.toArray(children);
      const content = items.filter(
        (child) =>
          !(
            (typeof child === "string" && child.trim() === "") ||
            (isValidElement(child) && child.type === "br")
          ),
      );
      if (content.length === 0) return <p>{children}</p>;
      const entries = content.map(resolveMedia);
      if (entries.every((entry) => entry === null)) return <p>{children}</p>;
      const images = entries.filter(
        (entry): entry is InlineMediaEntry => entry?.kind === "image",
      );
      if (images.length !== entries.length) return <div>{children}</div>;
      if (images.length === 1) return <>{children}</>;
      return (
        <MediaGrid
          items={images.map((entry) => ({
            path: entry.path,
            alt: entry.alt,
            offset: entry.offset,
          }))}
          gallery={gallery}
        />
      );
    },
  };
}

export const MarkdownContent = memo(function MarkdownContent({
  source,
  identity,
  revision = 0,
  generating = false,
  mentions = noMentions,
  inlineMedia = false,
}: {
  source: string;
  identity: string;
  revision?: number;
  generating?: boolean;
  mentions?: MessageMention[];
  inlineMedia?: boolean;
}) {
  const mentionKey = JSON.stringify(
    mentions.map(({ position, length }) => [position, length]),
  );
  const media = useMemo(
    () => (inlineMedia ? scanInlineMedia(source) : []),
    [inlineMedia, source],
  );
  const components = useMemo(() => {
    if (!inlineMedia) return baseComponents;
    return inlineComponents(
      media,
      media.filter((entry) => entry.kind === "image"),
    );
  }, [inlineMedia, media]);
  const remarkPlugins = useMemo<NonNullable<StreamdownProps["remarkPlugins"]>>(
    () => [
      ...Object.values(defaultRemarkPlugins),
      remarkMath,
      [
        remarkMentions,
        { source, mentions: generating ? noMentions : mentions },
      ],
      remarkBreaks,
      remarkLiteralHtml,
    ],
    [source, mentionKey, generating],
  );
  return (
    <div
      className={clsx(
        "markdown-content min-w-0 max-w-full font-sans text-fg wrap-anywhere",
        inlineMedia && "markdown-inline-media",
      )}
      data-content-id={identity}
      data-revision={revision}
    >
      <Streamdown
        key={`${identity}:${mentionKey}`}
        mode={generating ? "streaming" : "static"}
        isAnimating={generating}
        plugins={plugins}
        components={components}
        remarkPlugins={remarkPlugins}
        rehypePlugins={[]}
        urlTransform={defaultUrlTransform}
        controls={false}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
      >
        {source}
      </Streamdown>
    </div>
  );
});
