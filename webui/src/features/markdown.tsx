import { createCodePlugin } from "@streamdown/code";
import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import {
  CodeBlock,
  type Components,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  defaultUrlTransform,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { Button } from "@/components/ui/index";
import { toast } from "@/components/ui/toast";
import { LibraryLink } from "@/features/library/preview";
import { remarkLiteralHtml, remarkMentions } from "@/features/markdown-plugins";
import type { MessageMention } from "@/lib/backend";

const plugins = {
  code: createCodePlugin({ themes: ["github-dark", "github-dark"] }),
};
const rehypePlugins = [defaultRehypePlugins.harden];
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
      await navigator.clipboard.writeText(source);
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

export function libraryPathFromHref(href: string): string | null {
  if (!href.startsWith("/") && !href.startsWith("./")) return null;
  if (/%(?![0-9A-Fa-f]{2})/.test(href)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  const rest = decoded.startsWith("/") ? decoded.slice(1) : decoded.slice(2);
  const segments = rest.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const path = segments.filter((segment) => segment.length > 0).join("/");
  return path.length > 0 ? path : null;
}

const components: Components = {
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
    return href ? (
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
  img: ({ src, alt, node }) => {
    const href =
      typeof src === "string" && node
        ? defaultUrlTransform(src, "src", node)
        : undefined;
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-link"
      >
        {alt || src}
      </a>
    ) : (
      <span>{alt}</span>
    );
  },
};

export const MarkdownContent = memo(function MarkdownContent({
  source,
  identity,
  revision = 0,
  generating = false,
  mentions = noMentions,
}: {
  source: string;
  identity: string;
  revision?: number;
  generating?: boolean;
  mentions?: MessageMention[];
}) {
  const mentionKey = JSON.stringify(
    mentions.map(({ position, length }) => [position, length]),
  );
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
      className="markdown-content min-w-0 max-w-full font-sans text-fg wrap-anywhere"
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
        rehypePlugins={rehypePlugins}
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

export function CollapsibleText({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > 300);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="min-w-0 flex flex-col items-start gap-2">
      <div
        id={id}
        ref={root}
        className="relative w-full min-w-0"
        style={
          !expanded && overflow
            ? { maxHeight: 300, overflow: "hidden" }
            : undefined
        }
      >
        {children}
        {!expanded && overflow ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent"
          />
        ) : null}
      </div>
      {overflow ? (
        <Button
          size="sm"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
