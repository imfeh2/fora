import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import {
  Archive,
  ArchiveRestore,
  AtSign,
  ChevronDown,
  Loader2,
  MessageCircle,
  MessagesSquare,
  Send,
  Users,
} from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOrganization } from "@/app/organization";
import { useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader } from "@/components/layout/shell";
import { ContextMenuArea } from "@/components/ui/context-menu";
import {
  Avatar,
  AvatarStack,
  Button,
  Chip,
  dismissToast,
  LoadingSkeleton,
  Skeleton,
  toast,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { StatePanel } from "@/components/ui/state-panel";
import { Tooltip } from "@/components/ui/tooltip";
import { MessageAttachment } from "@/features/discussions/attachments";
import { Composer } from "@/features/discussions/composer";
import { DiscussionMembersDialog } from "@/features/discussions/members";
import { useThreadData } from "@/features/discussions/thread-data";
import {
  centeredScrollTop,
  shouldStopPositioningForKey,
} from "@/features/discussions/thread-position";
import {
  combineThreadUnits,
  type PreviewState,
  type ThreadUnit,
  useDiscussionPreviews,
} from "@/features/discussions/thread-previews";
import { GenerationIndicator } from "@/features/generation-state";
import { estimateInlineMediaSize } from "@/features/inline-media";
import { CopyTextButton, MarkdownContent } from "@/features/markdown";
import {
  BackendError,
  backend,
  type Member,
  type Message,
} from "@/lib/backend";
import { formatTime, relativeTime } from "@/lib/format";

const MentionInsert = createContext<((name: string) => void) | null>(null);

type PositioningKind = "none" | "entry" | "latest" | "follow";

function discussionWriteToastId(id: number, title: string): string {
  return `discussion-write:${id}:${title}`;
}

function reportDiscussionWriteFailure(
  id: number,
  title: string,
  failure: unknown,
) {
  if (failure instanceof BackendError && failure.transport) {
    backend.reportFailure(failure);
    return;
  }
  toast({
    id: discussionWriteToastId(id, title),
    tone: "danger",
    title,
    description: failure instanceof Error ? failure.message : String(failure),
    duration: null,
  });
}

function getKeyboardOffset(): number {
  if (typeof window === "undefined") return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;
  if (Math.abs(vv.scale - 1) > 0.01) return 0;
  return Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
}

export function getAvailableViewport(
  root: HTMLElement,
  composerHeight: number,
  keyboardOffset = 0,
) {
  const bounds = root.getBoundingClientRect();
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const viewportTop = vv ? vv.offsetTop : bounds.top;
  const viewportBottom = vv ? vv.offsetTop + vv.height : bounds.bottom;
  const effectiveTop = Math.max(bounds.top, viewportTop);
  const composerTop = bounds.bottom - keyboardOffset - composerHeight;
  const effectiveBottom = Math.min(bounds.bottom, viewportBottom, composerTop);
  return {
    top: effectiveTop,
    bottom: effectiveBottom,
    end: effectiveBottom,
  };
}

type ThreadPageProps = {
  id: number;
  focusComposer?: boolean;
  onComposerFocused?: () => void;
};

export function ThreadPage(props: ThreadPageProps) {
  const { id } = props;
  const { members, humanId, organizationError, connectionError } =
    useOrganization();
  const pending = !organizationError && !connectionError;
  if (members === null || humanId === null)
    return (
      <Page>
        <PageHeader
          title={
            pending ? (
              <Skeleton className="h-6 w-44 max-w-full" />
            ) : (
              "Discussion"
            )
          }
        />
        <PageBody variant="flush">
          <div className="@container relative flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-8 max-[940px]:px-6">
              {pending ? <ThreadSkeleton /> : null}
            </div>
            {pending ? (
              <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-center">
                <div className="w-full @[601px]:w-3/4">
                  <LoadingSkeleton label="Loading message composer">
                    <Skeleton className="h-12 w-full rounded-[24px]" />
                  </LoadingSkeleton>
                </div>
              </div>
            ) : null}
          </div>
        </PageBody>
      </Page>
    );
  return (
    <ThreadSession key={id} {...props} members={members} humanId={humanId} />
  );
}

function ThreadSkeleton() {
  return (
    <LoadingSkeleton label="Loading Discussion">
      {["90%", "75%", "50%"].map((width) => (
        <div key={width} className="flex gap-3 py-3">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex flex-1 min-w-0 flex-col gap-2">
            <Skeleton className="w-24" />
            <Skeleton style={{ width }} />
            <Skeleton className="w-1/2" />
          </div>
        </div>
      ))}
    </LoadingSkeleton>
  );
}

function ThreadSession({
  id,
  focusComposer,
  onComposerFocused,
  members,
  humanId,
}: ThreadPageProps & {
  members: Member[];
  humanId: number;
}) {
  const { discussions, refresh } = useOrganization();
  const navigate = useNavigate();
  const previews = useDiscussionPreviews(id);
  const thread = useThreadData(id, humanId);
  const { data: detail, missing, failed: loadFailed } = thread;
  const [busy, setBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [editingMembers, setEditingMembers] = useState(false);
  const [composerSize, setComposerSize] = useState(64);
  const composerSizeRef = useRef(64);
  const [keyboardOffset, setKeyboardOffset] = useState(getKeyboardOffset);
  const keyboardOffsetRef = useRef(keyboardOffset);
  const [atBottom, setAtBottom] = useState(true);
  const activePositioningSequence = useRef<number | null>(null);
  const activePositioningCount = useRef<number | null>(null);
  const positioningKind = useRef<PositioningKind>("none");
  const scrollButtonRef = useRef<HTMLButtonElement>(null);
  const buttonHeldFocus = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const initialReady = useRef(false);
  const ready = useRef(false);
  const shouldFollowBottom = useRef(false);
  const positioning = useRef(false);
  const positioningInterrupted = useRef(false);
  const positionStableFrames = useRef(0);
  const frame = useRef(0);
  const interruptFrame = useRef(0);
  const monitorFrame = useRef(0);
  const monitoring = useRef(false);
  const monitorStaleFrames = useRef(0);
  const monitorLastTop = useRef(-1);
  const unitCache = useRef(new Map<string, ThreadUnit>());
  const unitHeights = useRef(new WeakMap<ThreadUnit, number>());
  const [mention, setMention] = useState<{
    name: string;
    nonce: number;
  } | null>(null);
  const mentionNonce = useRef(0);
  const insertMention = useCallback((name: string) => {
    mentionNonce.current += 1;
    setMention({ name, nonce: mentionNonce.current });
  }, []);
  const units = useMemo(
    () =>
      combineThreadUnits(
        detail?.messages ?? [],
        previews.state,
        unitCache.current,
      ),
    [detail?.messages, previews.state],
  );
  const virtual = useVirtualizer({
    count: units.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index: number) => {
      const unit = units[index];
      if (unit === undefined) return 96;
      const cached = unitHeights.current.get(unit);
      if (cached !== undefined) return cached;
      const body = unit.message?.body ?? unit.preview?.data?.text.value ?? "";
      const size = 96 + estimateInlineMediaSize(body);
      unitHeights.current.set(unit, size);
      return size;
    },
    getItemKey: useCallback((index: number) => units[index].key, [units]),
    overscan: 5,
    anchorTo: "end",
    followOnAppend: detail !== null && !detail.hasAfter,
    paddingStart: 16,
    paddingEnd: composerSize + keyboardOffset + 24,
    scrollEndThreshold: 40,
    useAnimationFrameWithResizeObserver: true,
  });
  const resizeComposer = useCallback(
    (height: number) => {
      if (composerSizeRef.current === height) return;
      composerSizeRef.current = height;
      shouldFollowBottom.current = ready.current && virtual.isAtEnd();
      setComposerSize(height);
    },
    [virtual],
  );
  const items = virtual.getVirtualItems();
  const memberIds = useMemo(
    () => new Set((detail?.members ?? []).map((member) => member.id)),
    [detail?.members],
  );

  const sample = useCallback(
    (paginate = false) => {
      const root = scroll.current;
      const current = thread.current.current;
      if (!root || !ready.current || !current) return;
      const { top: effectiveTop, end } = getAvailableViewport(
        root,
        composerSize,
        keyboardOffset,
      );
      const visible: number[] = [];
      if (end > effectiveTop) {
        for (const element of root.querySelectorAll<HTMLElement>(
          "[data-message-id]",
        )) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > effectiveTop && rect.top < end)
            visible.push(Number(element.dataset.messageId));
        }
      }
      setAtBottom(virtual.isAtEnd());
      thread.view(visible, virtual.isAtEnd());
      if (
        document.visibilityState === "visible" &&
        visible.length &&
        !backend.disconnected &&
        !thread.loading
      )
        void thread.markRead(Math.max(...visible)).catch(() => {});
      if (positioning.current) return;
      if (
        previews.state.before &&
        !previews.state.loading &&
        !previews.state.error &&
        root.clientHeight > 0 &&
        (virtual.getTotalSize() <= root.clientHeight ||
          (paginate && root.scrollTop <= 200))
      )
        void previews.earlier();
      if (!thread.failed && !thread.loading) {
        if (
          current.hasBefore &&
          root.clientHeight > 0 &&
          (virtual.getTotalSize() <= root.clientHeight ||
            (paginate && root.scrollTop <= 200))
        )
          void thread.request("before");
        else if (
          paginate &&
          root.scrollHeight - root.scrollTop - root.clientHeight <
            root.clientHeight &&
          current.hasAfter
        )
          void thread.request("after");
      }
    },
    [composerSize, keyboardOffset, previews, thread, virtual],
  );

  const sampleRef = useRef(sample);
  useEffect(() => {
    sampleRef.current = sample;
  }, [sample]);

  const terminateOwnedTarget = useCallback(() => {
    const root = scroll.current;
    if (!root) return;
    virtual.scrollToOffset(root.scrollTop, { behavior: "auto" });
  }, [virtual]);

  const endPositioning = useCallback(() => {
    cancelAnimationFrame(frame.current);
    cancelAnimationFrame(monitorFrame.current);
    positioning.current = false;
    positioningKind.current = "none";
    monitoring.current = false;
    activePositioningSequence.current = null;
    activePositioningCount.current = null;
    ready.current = true;
    initialReady.current = true;
    thread.positioned();
    setAtBottom(virtual.isAtEnd());
  }, [thread.positioned, virtual]);

  const monitorSmoothScroll = useCallback(() => {
    const root = scroll.current;
    if (
      !positioning.current ||
      (positioningKind.current !== "latest" &&
        positioningKind.current !== "follow") ||
      !root
    ) {
      monitoring.current = false;
      return;
    }
    const currentTop = root.scrollTop;
    if (currentTop === monitorLastTop.current) monitorStaleFrames.current += 1;
    else {
      monitorStaleFrames.current = 0;
      monitorLastTop.current = currentTop;
    }
    if (virtual.isAtEnd(0)) {
      terminateOwnedTarget();
      endPositioning();
      sampleRef.current();
      return;
    }
    if (monitorStaleFrames.current >= 5) {
      terminateOwnedTarget();
      endPositioning();
      sampleRef.current();
      return;
    }
    monitorFrame.current = requestAnimationFrame(monitorSmoothScroll);
  }, [endPositioning, terminateOwnedTarget, virtual]);

  const startMonitoring = useCallback(() => {
    if (monitoring.current) return;
    monitoring.current = true;
    monitorStaleFrames.current = 0;
    monitorLastTop.current = scroll.current?.scrollTop ?? -1;
    monitorFrame.current = requestAnimationFrame(monitorSmoothScroll);
  }, [monitorSmoothScroll]);

  const followToEnd = useCallback(
    (landAtEnd: () => void) => {
      cancelAnimationFrame(frame.current);
      positioning.current = true;
      positioningKind.current = "follow";
      activePositioningCount.current = virtual.options.count;
      landAtEnd();
      startMonitoring();
    },
    [startMonitoring, virtual],
  );

  useEffect(
    () => () => {
      monitoring.current = false;
      cancelAnimationFrame(monitorFrame.current);
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(interruptFrame.current);
    },
    [],
  );

  const stopPositioning = useCallback(() => {
    shouldFollowBottom.current = false;
    thread.cancelPositioningIntent();
    if (!positioning.current) return;
    positioningInterrupted.current = true;
    terminateOwnedTarget();
    endPositioning();
    cancelAnimationFrame(interruptFrame.current);
    interruptFrame.current = requestAnimationFrame(() => {
      terminateOwnedTarget();
      positioningInterrupted.current = false;
      sampleRef.current();
    });
  }, [endPositioning, terminateOwnedTarget, thread]);

  const returnFocusToStableTarget = useCallback(() => {
    const currentActive = document.activeElement;
    const btn = scrollButtonRef.current;
    const isTargetingButton =
      btn !== null && (currentActive === btn || btn.contains(currentActive));
    const isDroppedToBodyFromButton =
      buttonHeldFocus.current &&
      (currentActive === document.body || currentActive === null);

    if (isTargetingButton || isDroppedToBodyFromButton) {
      buttonHeldFocus.current = false;
      const input =
        scroll.current?.parentElement?.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        );
      input?.focus();
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!positioning.current && thread.positioningIntent.current === null)
        return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const inThreadScope =
        scroll.current?.contains(target) ||
        scrollButtonRef.current?.contains(target) ||
        target === document.body;
      if (inThreadScope && shouldStopPositioningForKey(event.key, target))
        stopPositioning();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [stopPositioning]);

  useLayoutEffect(() => {
    if (!thread.position || !detail || !scroll.current) return;
    const position = thread.position;

    if (position.mode === "latest") {
      if (position.source === "user") {
        const alreadyOwned =
          positioning.current &&
          positioningKind.current === "latest" &&
          activePositioningSequence.current === position.sequence;
        if (alreadyOwned) {
          startMonitoring();
          return;
        }
        if (!thread.consumePositioningIntent(position.sequence)) {
          endPositioning();
          return;
        }
        cancelAnimationFrame(frame.current);
        cancelAnimationFrame(monitorFrame.current);
        monitoring.current = false;
        activePositioningSequence.current = position.sequence;
        activePositioningCount.current = units.length;
        positioningKind.current = "latest";
        ready.current = false;
        positioning.current = true;
        const prefersReducedMotion =
          typeof window !== "undefined" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        virtual.scrollToEnd({
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
        startMonitoring();
        return;
      }

      if (!initialReady.current && detail.divider === null) {
        followToEnd(() => virtual.scrollToEnd());
        return;
      }

      if (shouldFollowBottom.current || atBottom) {
        followToEnd(() => virtual.scrollToEnd({ behavior: "auto" }));
        return;
      }

      endPositioning();
      return;
    }

    if (detail.divider === null) {
      if (initialReady.current) endPositioning();
      else followToEnd(() => virtual.scrollToEnd());
      return;
    }

    const index = units.findIndex(
      (unit) => unit.message?.id === detail.divider,
    );
    if (index < 0) throw new Error("Entry divider is missing from its page");
    positioning.current = true;
    positioningKind.current = "entry";
    positionStableFrames.current = 0;
    let missingMarkerFrames = 0;
    virtual.scrollToIndex(index, { align: "center" });

    const positionNewMarker = () => {
      if (!positioning.current || positioningKind.current !== "entry") return;
      const root = scroll.current;
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      if (root.clientHeight === 0 || bounds.height === 0) {
        frame.current = requestAnimationFrame(positionNewMarker);
        return;
      }
      const marker = root.querySelector<HTMLElement>("[data-new-divider]");
      if (!marker) {
        missingMarkerFrames += 1;
        if (missingMarkerFrames > 10)
          throw new Error("New divider did not render after entry positioning");
        virtual.scrollToIndex(index, { align: "center" });
        frame.current = requestAnimationFrame(positionNewMarker);
        return;
      }
      missingMarkerFrames = 0;
      const available = getAvailableViewport(
        root,
        composerSize,
        keyboardOffset,
      );
      if (
        root.clientHeight === 0 ||
        bounds.height === 0 ||
        available.end <= available.top
      ) {
        frame.current = requestAnimationFrame(positionNewMarker);
        return;
      }
      const target = centeredScrollTop(
        root.scrollTop,
        root.scrollHeight - root.clientHeight,
        marker.getBoundingClientRect().top,
        available.top,
        available.end,
      );
      const needsCorrection = Math.abs(target - root.scrollTop) >= 0.5;
      virtual.scrollToOffset(target);
      if (needsCorrection) positionStableFrames.current = 0;
      else positionStableFrames.current += 1;
      if (positionStableFrames.current >= 2) {
        virtual.scrollToOffset(root.scrollTop);
        endPositioning();
        sample();
      } else {
        frame.current = requestAnimationFrame(positionNewMarker);
      }
    };
    frame.current = requestAnimationFrame(positionNewMarker);
    return () => {
      if (positioningKind.current === "entry")
        cancelAnimationFrame(frame.current);
    };
  }, [
    thread.position,
    thread.consumePositioningIntent,
    detail?.divider,
    units,
    virtual,
    startMonitoring,
    endPositioning,
    followToEnd,
    composerSize,
    keyboardOffset,
  ]);

  useLayoutEffect(() => {
    if (
      !positioning.current ||
      (positioningKind.current !== "latest" &&
        positioningKind.current !== "follow") ||
      activePositioningCount.current === units.length
    )
      return;
    activePositioningCount.current = units.length;
    const smooth =
      positioningKind.current === "latest" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    virtual.scrollToEnd({ behavior: smooth ? "smooth" : "auto" });
  }, [units.length, virtual]);

  useEffect(() => {
    const tick = requestAnimationFrame(() => sample());
    const changed = () => sample();
    const observer = new ResizeObserver(changed);
    if (scroll.current) observer.observe(scroll.current);
    document.addEventListener("visibilitychange", changed);
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const onViewport = () => {
      const nextOffset = getKeyboardOffset();
      if (keyboardOffsetRef.current !== nextOffset) {
        keyboardOffsetRef.current = nextOffset;
        shouldFollowBottom.current = ready.current && virtual.isAtEnd();
        setKeyboardOffset(nextOffset);
      } else {
        sample();
      }
    };
    if (vv) {
      vv.addEventListener("resize", onViewport);
      vv.addEventListener("scroll", onViewport);
    }
    return () => {
      cancelAnimationFrame(tick);
      observer.disconnect();
      document.removeEventListener("visibilitychange", changed);
      if (vv) {
        vv.removeEventListener("resize", onViewport);
        vv.removeEventListener("scroll", onViewport);
      }
    };
  }, [sample, items, virtual]);

  useLayoutEffect(() => {
    const follow = shouldFollowBottom.current;
    shouldFollowBottom.current = false;
    if (ready.current && follow) {
      virtual.scrollToEnd();
    }
    sample();
  }, [composerSize, keyboardOffset, virtual, sample]);

  const load = thread.invalidate;

  const send = async (
    body: string,
    attachmentIds: string[],
    clientMessageId: string,
  ) => {
    if (!detail || !memberIds.has(humanId) || backend.disconnected)
      return false;
    setBusy(true);
    let sent = false;
    try {
      await backend.sendVisible(id, body, attachmentIds, clientMessageId);
      sent = true;
      if (!thread.live.current) return true;
      await thread.request("after");
      return true;
    } catch (failure) {
      if (failure instanceof BackendError && failure.code === "send_cancelled")
        return "cancelled" as const;
      if (sent) return true;
      if (failure instanceof BackendError && failure.transport) return false;
      throw failure;
    } finally {
      if (thread.live.current) setBusy(false);
    }
  };

  const handleMore = useCallback(
    (previewId: string) => void previews.more(previewId),
    [previews.more],
  );
  const handleRetry = useCallback(
    (previewId: string) => void previews.retry(previewId),
    [previews.retry],
  );

  const archive = async (archived: boolean) => {
    if (archiveBusy) return;
    setArchiveBusy(true);
    const title = archived
      ? "Could not archive Discussion"
      : "Could not unarchive Discussion";
    try {
      await backend.archiveDiscussion(id, archived);
      dismissToast(discussionWriteToastId(id, title));
      if (!thread.live.current) return;
      if (archived) navigate({ name: "discussions" });
      else await load();
    } catch (failure) {
      if (thread.live.current) reportDiscussionWriteFailure(id, title, failure);
    } finally {
      if (thread.live.current) setArchiveBusy(false);
    }
  };

  const names = (detail?.members ?? []).map((member) => member.name);
  const topic =
    discussions?.find((item) => item.id === id)?.topic ?? detail?.topic ?? "";

  const handleScrollToBottom = useCallback(() => {
    if (thread.loading) return;
    buttonHeldFocus.current =
      scrollButtonRef.current !== null &&
      (document.activeElement === scrollButtonRef.current ||
        scrollButtonRef.current.contains(document.activeElement));
    void thread.request("latest", { source: "user" });
  }, [thread]);

  const discussionSummary = discussions?.find((item) => item.id === id);
  const unreadCount = discussionSummary?.unread ?? 0;
  const showScrollButton =
    initialReady.current &&
    detail !== null &&
    units.length > 0 &&
    (!atBottom || detail.hasAfter);

  const prevShowScrollButton = useRef(showScrollButton);
  useEffect(() => {
    if (prevShowScrollButton.current && !showScrollButton) {
      returnFocusToStableTarget();
    }
    prevShowScrollButton.current = showScrollButton;
  }, [showScrollButton, returnFocusToStableTarget]);

  return (
    <MentionInsert.Provider value={insertMention}>
      <Page>
        <PageHeader
          title={
            missing
              ? "Discussion not found"
              : topic ||
                (loadFailed ? (
                  "Unavailable"
                ) : (
                  <Skeleton className="h-6 w-44 max-w-full" />
                ))
          }
          status={detail?.archived ? <Chip>Archived</Chip> : undefined}
          actions={
            missing ? (
              <Button onClick={() => navigate({ name: "discussions" })}>
                Back to Discussions
              </Button>
            ) : detail ? (
              <>
                <Tooltip label={names.join("\n")}>
                  <Button
                    variant="ghost"
                    aria-label="Members"
                    onClick={() => setEditingMembers(true)}
                  >
                    <AvatarStack members={detail.members} />
                  </Button>
                </Tooltip>
                <OverflowMenu
                  label="Discussion actions"
                  actions={[
                    {
                      id: "members",
                      label: "Members",
                      icon: <Users size={15} />,
                      onSelect: () => setEditingMembers(true),
                    },
                    detail.archived
                      ? {
                          id: "unarchive",
                          label: "Unarchive",
                          icon: <ArchiveRestore size={15} />,
                          disabled: archiveBusy,
                          onSelect: () => void archive(false),
                        }
                      : {
                          id: "archive",
                          label: "Archive",
                          icon: <Archive size={15} />,
                          disabled: archiveBusy,
                          onSelect: () => void archive(true),
                        },
                  ]}
                />
              </>
            ) : undefined
          }
        />

        <PageBody variant="flush">
          <div className="@container relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroll}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto border-t border-line px-8 max-[940px]:px-6 narrow:px-3 [overflow-anchor:none]"
              onScroll={() => {
                shouldFollowBottom.current = false;
                if (positioningInterrupted.current && scroll.current)
                  virtual.scrollToOffset(scroll.current.scrollTop);
                sample(true);
              }}
              onWheel={stopPositioning}
              onTouchStart={stopPositioning}
              onPointerDown={stopPositioning}
              aria-busy={thread.loading}
            >
              {!detail && !loadFailed && !missing ? <ThreadSkeleton /> : null}
              {detail &&
              units.length === 0 &&
              !previews.state.loading &&
              !thread.loading &&
              !loadFailed ? (
                <div
                  className="flex min-h-full flex-col"
                  style={{ paddingBottom: composerSize + keyboardOffset + 24 }}
                >
                  <StatePanel
                    icons={[MessageCircle, MessagesSquare, Send]}
                    title="No messages yet"
                    description="Write the first message to start this Discussion."
                    action={{
                      label: "Write a message",
                      icon: <Send size={16} />,
                      onClick: () => {
                        const input =
                          scroll.current?.parentElement?.querySelector<HTMLTextAreaElement>(
                            'textarea[aria-label="Message"]',
                          );
                        if (!input) throw new Error("Message input is missing");
                        input.focus();
                      },
                    }}
                  />
                </div>
              ) : null}
              {previews.state.error ? (
                <div role="alert" className="py-3 text-sm text-danger">
                  <p>{previews.state.error.message}</p>
                  <Button size="sm" onClick={() => void previews.refresh()}>
                    Retry
                  </Button>
                </div>
              ) : null}
              {Object.entries(previews.state.resources).map(
                ([previewId, state]) =>
                  !state.data &&
                  state.error &&
                  ![
                    "not_found",
                    "not_a_member",
                    "not_permitted",
                    "permission_denied",
                  ].includes(state.error.code) ? (
                    <div
                      key={previewId}
                      role="alert"
                      className="py-3 text-sm text-danger"
                    >
                      <p>{state.error.message}</p>
                      <Button
                        size="sm"
                        disabled={state.loading}
                        onClick={() => void previews.retry(previewId)}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null,
              )}
              <ol
                className="relative transition-none"
                hidden={units.length === 0}
                style={{ height: virtual.getTotalSize() }}
              >
                {items.map((item) => {
                  const unit = units[item.index];
                  const message = unit.message;
                  const previousSender =
                    item.index === 0
                      ? detail?.previousSender
                      : units[item.index - 1].senderId;
                  const divider = message?.id === detail?.divider;
                  const compact = !divider && previousSender === unit.senderId;
                  return (
                    <li
                      key={item.key}
                      ref={virtual.measureElement}
                      data-index={item.index}
                      className="absolute top-0 left-0 w-full"
                      style={{
                        transform: `translateY(${item.start}px)`,
                        paddingTop: compact ? 4 : 16,
                      }}
                    >
                      {divider ? (
                        <div
                          data-new-divider
                          className="mb-4 flex items-center gap-3 text-xs font-medium uppercase tracking-caps text-primary before:content-[''] before:h-px before:flex-1 before:bg-blue-500/40 after:content-[''] after:h-px after:flex-1 after:bg-blue-500/40"
                        >
                          <span>New</span>
                        </div>
                      ) : null}
                      <MessageRow
                        discussionId={id}
                        message={message}
                        preview={unit.preview}
                        identity={unit.key}
                        compact={compact}
                        fresh={false}
                        onMore={handleMore}
                        onRetry={handleRetry}
                      />
                    </li>
                  );
                })}
              </ol>
            </div>
            {showScrollButton ? (
              <div
                className="absolute right-8 narrow:right-3 z-10"
                style={{ bottom: composerSize + keyboardOffset + 8 }}
              >
                <ScrollToBottomButton
                  buttonRef={scrollButtonRef}
                  unreadCount={unreadCount}
                  loading={thread.loading}
                  onClick={handleScrollToBottom}
                  onFocus={() => {
                    buttonHeldFocus.current = true;
                  }}
                  onBlur={(event) => {
                    if (
                      event.relatedTarget &&
                      event.relatedTarget !== document.body
                    ) {
                      buttonHeldFocus.current = false;
                    }
                  }}
                />
              </div>
            ) : null}

            <Composer
              discussionId={id}
              members={members}
              memberIds={memberIds}
              busy={busy}
              disabled={
                !detail || !memberIds.has(humanId) || backend.disconnected
              }
              placeholder={topic ? `Message ${topic}` : "Message"}
              onSend={send}
              onHeightChange={resizeComposer}
              focusOnReady={focusComposer}
              onFocused={onComposerFocused}
              keyboardOffset={keyboardOffset}
              mentionRequest={mention}
              onOpenVoiceSettings={() =>
                navigate({ name: "settings", section: "voice" })
              }
            />
          </div>
        </PageBody>

        {editingMembers && detail ? (
          <DiscussionMembersDialog
            discussionId={id}
            memberIds={detail.members.map((member) => member.id)}
            onClose={() => setEditingMembers(false)}
            onSaved={async (ids) => {
              await refresh();
              if (!thread.live.current) return;
              if (ids.includes(humanId)) await load();
              else navigate({ name: "discussions" });
            }}
          />
        ) : null}
      </Page>
    </MentionInsert.Provider>
  );
}

export function ScrollToBottomButton({
  unreadCount,
  loading,
  onClick,
  buttonRef,
  onFocus,
  onBlur,
}: {
  unreadCount: number;
  loading: boolean;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
}) {
  const badgeText =
    unreadCount > 99 ? "99+" : unreadCount > 0 ? String(unreadCount) : null;
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={
        unreadCount > 0
          ? `Scroll to latest messages (${badgeText} unread)`
          : "Scroll to latest messages"
      }
      disabled={loading}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      className={clsx(
        "relative flex size-10 items-center justify-center rounded-full border border-line-interactive bg-surface text-fg shadow-md transition-all duration-(--duration-fast) ease-linear",
        "hover:enabled:border-line-hover hover:enabled:bg-surface-hover hover:enabled:text-fg active:enabled:bg-surface-pressed",
        "focus-visible:border-line-hover focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "narrow:before:absolute narrow:before:-inset-0.5 narrow:before:content-[''] touch:before:absolute touch:before:-inset-0.5 touch:before:content-['']",
      )}
    >
      {loading ? (
        <Loader2 size={18} className="animate-spin text-fg-muted" />
      ) : (
        <ChevronDown size={18} />
      )}
      {badgeText ? (
        <span
          data-unread-badge
          aria-hidden="true"
          className="absolute -top-1.5 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-surface bg-blue-500 px-1 text-[11px] font-semibold leading-none text-gray-0 select-none"
        >
          {badgeText}
        </span>
      ) : null}
    </button>
  );
}

export const MessageRow = memo(function MessageRow({
  discussionId,
  message,
  preview,
  identity,
  onMore,
  onRetry,
  compact,
  fresh,
}: {
  discussionId: number;
  message?: Message;
  preview?: PreviewState;
  identity?: string;
  onMore?: (previewId: string) => void;
  onRetry?: (previewId: string) => void;
  compact: boolean;
  fresh: boolean;
}) {
  const { members } = useOrganization();
  const insertMention = useContext(MentionInsert);
  const [copyOpen, setCopyOpen] = useState(false);
  const saved = preview?.data;
  useEffect(() => {
    if (!copyOpen) return;
    const away = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".message-copy-float"))
        return;
      setCopyOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [copyOpen]);
  const { humanId } = useOrganization();
  if (!message && !saved)
    throw new Error("Message reading unit has no content");
  const senderId = message?.sender_id ?? saved?.metadata.key.agent_id;
  if (senderId === undefined) throw new Error("Message sender is missing");
  const source = message?.body ?? saved?.text.value;
  const timestamp = message?.created_at ?? saved?.metadata.created_at;
  if (source === undefined || timestamp === undefined)
    throw new Error("Message text or timestamp is missing");
  const name =
    message?.sender_name ??
    members?.find((member) => member.id === senderId)?.name;
  const status = saved?.metadata.status;
  const failed = status === "failed" || status === "interrupted";
  if (!message && failed && !saved?.metadata.error)
    throw new Error("Generation failure reason is missing");
  const generating =
    !message && (status === "generating" || status === "sending");
  return (
    <div
      data-message-id={message?.id}
      data-preview-id={!message ? saved?.metadata.preview_id : undefined}
      data-copy-open={copyOpen ? "true" : undefined}
      className={clsx(
        "message-row flex scroll-m-6 items-start gap-3",
        fresh && "animate-rise-in [animation-duration:var(--duration-slow)]",
      )}
    >
      <div className="w-[26px] flex-none">
        {compact ? null : name === undefined || senderId === humanId ? (
          <Avatar memberId={senderId} />
        ) : (
          <ContextMenuArea
            asChild
            label={`Actions for ${name}`}
            actions={[
              {
                id: "mention",
                label: `@${name}`,
                icon: <AtSign size={15} />,
                onSelect: () => insertMention?.(name),
              },
            ]}
          >
            <span>
              <Avatar memberId={senderId} />
            </span>
          </ContextMenuArea>
        )}
      </div>
      <div
        className="relative -ml-3 min-w-0 flex-1 border-l-2 border-l-transparent pl-3"
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") setCopyOpen(true);
        }}
      >
        <span className="message-copy message-copy-float absolute top-0 right-0 z-10 rounded-xs bg-app/95">
          <CopyTextButton
            source={source}
            label="Copy message text"
            touchTarget
          />
        </span>
        <div className="mb-0.5 flex items-center gap-2">
          {compact ? null : (
            <>
              <span className="font-semibold">{name}</span>
              <Tooltip label={formatTime(timestamp)}>
                <time className="text-xs text-fg-muted" dateTime={timestamp}>
                  {relativeTime(timestamp)}
                </time>
              </Tooltip>
            </>
          )}
          {!message && failed && saved ? (
            <GenerationIndicator
              state={{
                status,
                reason: String(saved.metadata.error),
              }}
            />
          ) : null}
        </div>
        <MarkdownContent
          source={source}
          identity={identity ?? `message:${discussionId}:${message?.id}`}
          revision={saved?.text.revision}
          generating={generating}
          mentions={message?.mentions}
          inlineMedia
        />
        {generating ? <GenerationIndicator state={{ status }} /> : null}
        {preview?.error ? (
          <div role="alert" className="mt-2 text-sm text-danger">
            <p>{preview.error.message}</p>
            <Button
              size="sm"
              disabled={preview.loading}
              onClick={() =>
                preview.data && onRetry?.(preview.data.metadata.preview_id)
              }
            >
              Retry
            </Button>
          </div>
        ) : !message && saved?.text.has_more ? (
          <Button
            size="sm"
            disabled={preview?.loading}
            aria-label="Load more text"
            aria-busy={preview?.loading}
            onClick={() =>
              preview?.data && onMore?.(preview.data.metadata.preview_id)
            }
          >
            {preview?.loading ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : null}
            Load more text
          </Button>
        ) : null}
        {message?.attachments.map((attachment) => (
          <MessageAttachment
            key={attachment.id}
            discussionId={discussionId}
            messageId={message.id}
            attachment={attachment}
          />
        ))}
      </div>
    </div>
  );
});
