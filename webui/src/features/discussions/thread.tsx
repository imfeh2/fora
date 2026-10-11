import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Loader2,
  MessageCircle,
  MessagesSquare,
  Send,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOrganization } from "@/app/organization";
import { useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader } from "@/components/layout/shell";
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
import { renderMentions } from "@/features/mentions";
import {
  BackendError,
  backend,
  type Member,
  type Message,
} from "@/lib/backend";
import { formatTime, relativeTime } from "@/lib/format";

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
  const thread = useThreadData(id, humanId);
  const { data: detail, missing, failed: loadFailed } = thread;
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [editingMembers, setEditingMembers] = useState(false);
  const [composerSize, setComposerSize] = useState(64);
  const composerSizeRef = useRef(64);
  const [keyboardOffset, setKeyboardOffset] = useState(getKeyboardOffset);
  const keyboardOffsetRef = useRef(keyboardOffset);
  const [atBottom, setAtBottom] = useState(true);
  const activePositioningSequence = useRef<number | null>(null);
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
  const messages = detail?.messages ?? [];
  const virtual = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 96,
    getItemKey: useCallback((index: number) => messages[index].id, [messages]),
    overscan: 5,
    anchorTo: "end",
    followOnAppend: detail !== null && !detail.hasAfter,
    paddingStart: 16,
    paddingEnd: composerSize + keyboardOffset + 24,
    scrollEndThreshold: 1,
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
      if (!thread.failed && !thread.loading) {
        if (
          current.hasBefore &&
          root.clientHeight > 0 &&
          (virtual.getTotalSize() <= root.clientHeight ||
            (paginate && root.scrollTop < root.clientHeight))
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
    [composerSize, keyboardOffset, thread, virtual],
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
    ready.current = true;
    initialReady.current = true;
    thread.positioned();
    setAtBottom(virtual.isAtEnd());
  }, [thread.positioned, virtual]);

  const followToEnd = useCallback(
    (landAtEnd: () => void) => {
      cancelAnimationFrame(frame.current);
      positioning.current = true;
      positioningKind.current = "follow";
      landAtEnd();
      frame.current = requestAnimationFrame(() => {
        if (positioningKind.current !== "follow") return;
        endPositioning();
      });
    },
    [endPositioning],
  );

  const monitorSmoothScroll = useCallback(() => {
    const root = scroll.current;
    if (!positioning.current || positioningKind.current !== "latest" || !root) {
      monitoring.current = false;
      return;
    }
    const currentTop = root.scrollTop;
    if (currentTop === monitorLastTop.current) monitorStaleFrames.current += 1;
    else {
      monitorStaleFrames.current = 0;
      monitorLastTop.current = currentTop;
    }
    if (virtual.isAtEnd()) {
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

    const index = messages.findIndex(
      (message) => message.id === detail.divider,
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
    messages,
    virtual,
    startMonitoring,
    endPositioning,
    followToEnd,
    composerSize,
    keyboardOffset,
  ]);

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

  const ack = async (messageIds: number[], revoke = false) => {
    if (ackBusy) return;
    setAckBusy(true);
    const title = revoke ? "Could not undo" : "Could not mark handled";
    try {
      if (revoke) {
        await backend.revokeAck(id, messageIds);
        dismissToast(discussionWriteToastId(id, title));
      } else {
        await thread.markRead(Math.max(...messageIds));
        if (!thread.live.current) return;
        await backend.ack(id, messageIds);
        dismissToast(discussionWriteToastId(id, title));
      }
      if (thread.live.current) await load();
    } catch (failure) {
      if (
        thread.live.current &&
        !(
          failure instanceof BackendError &&
          ["reading_position_failed", "reading_position_blocked"].includes(
            failure.code,
          )
        )
      )
        reportDiscussionWriteFailure(id, title, failure);
    } finally {
      if (thread.live.current) setAckBusy(false);
    }
  };

  const ackAll = async () => {
    if (ackBusy || !detail) return;
    setAckBusy(true);
    try {
      await backend.ackPending(id, detail.latest);
      dismissToast(discussionWriteToastId(id, "Could not mark all handled"));
      if (thread.live.current) await load();
    } catch (failure) {
      if (thread.live.current)
        reportDiscussionWriteFailure(id, "Could not mark all handled", failure);
    } finally {
      if (thread.live.current) setAckBusy(false);
    }
  };

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
    messages.length > 0 &&
    (!atBottom || detail.hasAfter);

  const prevShowScrollButton = useRef(showScrollButton);
  useEffect(() => {
    if (prevShowScrollButton.current && !showScrollButton) {
      returnFocusToStableTarget();
    }
    prevShowScrollButton.current = showScrollButton;
  }, [showScrollButton, returnFocusToStableTarget]);

  return (
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
              {detail.pendingCount > 0 ? (
                <Button
                  variant="primary"
                  disabled={ackBusy}
                  onClick={() => void ackAll()}
                >
                  <Check size={16} />
                  Mark all handled
                </Button>
              ) : null}
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
            className="min-h-0 flex-1 overflow-y-auto border-t border-line px-8 max-[940px]:px-6 narrow:px-3 [overflow-anchor:none]"
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
            messages.length === 0 &&
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
            <ol
              className="relative"
              hidden={messages.length === 0}
              style={{ height: virtual.getTotalSize() }}
            >
              {items.map((item) => {
                const message = messages[item.index];
                const previousSender =
                  item.index === 0
                    ? detail?.previousSender
                    : messages[item.index - 1].sender_id;
                const divider = message.id === detail?.divider;
                const compact =
                  !divider && previousSender === message.sender_id;
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
                      compact={compact}
                      fresh={false}
                      pending={message.pending}
                      acknowledged={message.acknowledged}
                      busy={ackBusy}
                      onAck={() => void ack([message.id])}
                      onRevoke={() => void ack([message.id], true)}
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
        "hover:enabled:border-line-hover hover:enabled:bg-surface-hover hover:enabled:text-fg active:enabled:bg-gray-600",
        "focus-visible:border-line-focus focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-ring)_40%,transparent)]",
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

export function MessageRow({
  discussionId,
  message,
  compact,
  fresh,
  pending,
  acknowledged,
  busy,
  onAck,
  onRevoke,
}: {
  discussionId: number;
  message: Message;
  compact: boolean;
  fresh: boolean;
  pending: boolean;
  acknowledged: boolean;
  busy: boolean;
  onAck: () => void;
  onRevoke: () => void;
}) {
  const { members } = useOrganization();
  return (
    <div
      data-message-id={message.id}
      className={clsx(
        "flex scroll-m-6 items-start gap-3",
        fresh && "animate-rise-in [animation-duration:var(--duration-slow)]",
      )}
    >
      <div className="w-[26px] flex-none">
        {compact ? null : <Avatar memberId={message.sender_id} />}
      </div>
      <div
        className={clsx(
          "-ml-3 min-w-0 flex-1 border-l-2 pl-3",
          pending ? "border-l-yellow-300" : "border-l-transparent",
        )}
      >
        {compact ? null : (
          <div className="mb-0.5 flex items-baseline gap-2">
            <span className="font-semibold">{message.sender_name}</span>
            <Tooltip label={formatTime(message.created_at)}>
              <time
                className="text-xs text-fg-muted"
                dateTime={message.created_at}
              >
                {relativeTime(message.created_at)}
              </time>
            </Tooltip>
          </div>
        )}
        <div className="whitespace-pre-wrap wrap-anywhere [&_mark]:bg-blue-500/25 [&_mark]:text-blue-100 [&_mark]:rounded-xs [&_mark]:px-[3px] [&_mark]:font-medium">
          {members === null
            ? message.body
            : renderMentions(message.body, message.mentions, members)}
        </div>
        {message.attachments.map((attachment) => (
          <MessageAttachment
            key={attachment.id}
            discussionId={discussionId}
            messageId={message.id}
            attachment={attachment}
          />
        ))}
        {pending ? (
          <div className="mt-2 flex items-center gap-2">
            <Chip tone="warning">Mentions you</Chip>
            <Button size="sm" touchTarget disabled={busy} onClick={onAck}>
              <Check size={13} />
              Mark handled
            </Button>
          </div>
        ) : acknowledged ? (
          <div className="mt-2 flex items-center gap-2">
            <Chip tone="success">Handled</Chip>
            <Button
              size="sm"
              touchTarget
              disabled={busy}
              aria-label="Undo confirmation"
              onClick={onRevoke}
            >
              Undo
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
