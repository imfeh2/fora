import { clsx } from "clsx";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTouchOrNarrow } from "@/components/layout/shell";
import {
  Avatar,
  autoGrowHeight,
  dismissToast,
  Spinner,
  Textarea,
  toast,
} from "@/components/ui/index";
import { DraftAttachments } from "@/features/discussions/attachments";
import { type SendDraft, useDraft } from "@/features/discussions/draft";
import {
  candidatesFor,
  completeMention,
  type MentionCandidate,
  mentionQuery,
} from "@/features/mentions";
import { backend, type Member } from "@/lib/backend";
import { VoiceRecording, type VoiceState } from "@/lib/voice";

const MENU_LIMIT = 8;

function ArrowUpIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="5"
        y="1"
        width="4"
        height="7"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2.75 6.5V7a4.25 4.25 0 0 0 8.5 0v-.5M7 11.25V13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EveryoneIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="5" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M1.5 12V10a3.5 3.5 0 0 1 7 0v2M9 2.25a2 2 0 0 1 0 3.5M10.5 7a3 3 0 0 1 2 2.83V12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7 2.5V11.5M2.5 7H11.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function composerFades(top: number, height: number, viewport: number) {
  return {
    top: Math.min(top / 20, 1),
    bottom: Math.min(Math.max(height - viewport - top - 16, 0) / 10, 1),
  };
}

export function composerMultiline(
  value: string,
  height: number,
  line: number,
  padding: number,
) {
  return (
    value.includes("\n") ||
    (value.length > 0 && height > Math.ceil(line + padding) + 1)
  );
}

export function composerHeight(
  expanded: boolean,
  inputHeight: number,
  isTouchOrNarrow = false,
) {
  return expanded
    ? Math.min(252, Math.max(116, inputHeight + 48))
    : isTouchOrNarrow
      ? 52
      : 48;
}

export type ComposerKey = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
};

export type ComposerAction =
  | "send"
  | "newline"
  | "accept"
  | "dismiss"
  | "up"
  | "down";

export function composerKey(
  event: ComposerKey,
  suggesting: boolean,
): ComposerAction | null {
  if (event.isComposing) return null;
  if (suggesting) {
    if (event.key === "ArrowDown") return "down";
    if (event.key === "ArrowUp") return "up";
    if (event.key === "Escape") return "dismiss";
    if (event.key === "Tab") return "accept";
  }
  if (event.key !== "Enter") return null;
  if (event.ctrlKey || event.metaKey) return "send";
  if (event.shiftKey) return "newline";
  return suggesting ? "accept" : "send";
}

export function Composer({
  discussionId,
  members,
  memberIds,
  busy,
  disabled = false,
  placeholder,
  onSend,
  onHeightChange,
  onOpenVoiceSettings,
  focusOnReady = false,
  onFocused,
  keyboardOffset = 0,
}: {
  discussionId: number;
  members: Member[];
  memberIds: ReadonlySet<number>;
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  onSend: SendDraft;
  onHeightChange: (height: number) => void;
  onOpenVoiceSettings: () => void;
  focusOnReady?: boolean;
  onFocused?: () => void;
  keyboardOffset?: number;
}) {
  const {
    controller,
    view,
    error: draftError,
    retry: retryDraft,
  } = useDraft(discussionId);
  const body = view?.draft.body ?? "";
  const files = view?.draft.files ?? [];
  const setBody = (value: string) => controller?.setBody(value);
  const sending = busy || !!view?.busy;
  const canSend =
    !!controller &&
    !view?.moved &&
    !view?.recovering &&
    !view?.draft.pending?.cancelRequested &&
    !!(body.trim() || files.length || view?.draft.pending);
  const fileInput = useRef<HTMLInputElement>(null);
  const extra = useRef<HTMLDivElement>(null);
  const [extraHeight, setExtraHeight] = useState(0);
  useLayoutEffect(() => {
    const element = extra.current;
    if (!element) return;
    const update = () => setExtraHeight(element.getBoundingClientRect().height);
    const observer = new ResizeObserver(update);
    update();
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [voiceState, setVoiceState] = useState<VoiceState>("closed");

  const recording = useRef<VoiceRecording | null>(null);
  const voiceConfigRead = useRef<number | null>(null);
  const voiceConfigVersion = useRef(0);
  const mounted = useRef(true);
  const nextVoiceConfigVersion = useRef(0);
  const submissionUnsubscribe = useRef<(() => void) | null>(null);
  const recordingActive = voiceState !== "closed";
  const releaseSubmission = () => {
    submissionUnsubscribe.current?.();
    submissionUnsubscribe.current = null;
  };
  const cancelRecording = () => {
    const active = recording.current;
    recording.current = null;
    releaseSubmission();
    active?.cancel();
    setVoiceState("closed");
  };
  const currentDraft = useRef({ controller, discussionId });
  currentDraft.current = { controller, discussionId };
  useEffect(
    () => () => {
      const active = recording.current;
      recording.current = null;
      releaseSubmission();
      active?.cancel();
      voiceConfigRead.current = null;
      dismissToast("voice-input");
      if (
        currentDraft.current.controller !== controller ||
        currentDraft.current.discussionId !== discussionId
      )
        setVoiceState("closed");
    },
    [controller, discussionId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      voiceConfigRead.current = null;
    };
  }, []);
  const showVoiceSettingsToast = () => {
    toast({
      id: "voice-settings",
      tone: "info",
      title: "Set up voice transcription",
      description: "Add an API key in Voice settings to start voice input.",
      duration: null,
      action: {
        label: "Open Voice settings",
        onClick: onOpenVoiceSettings,
      },
    });
  };
  const startRecording = async () => {
    if (
      disabled ||
      !controller ||
      recording.current ||
      voiceConfigRead.current !== null
    )
      return;
    const target = controller;
    const version = ++nextVoiceConfigVersion.current;
    voiceConfigVersion.current = version;
    voiceConfigRead.current = version;
    dismissToast("voice-input");
    const isCurrentVoiceConfigRead = () =>
      mounted.current &&
      voiceConfigVersion.current === version &&
      voiceConfigRead.current === version &&
      currentDraft.current.controller === target &&
      currentDraft.current.discussionId === discussionId;
    const releaseVoiceConfigRead = () => {
      if (voiceConfigRead.current === version) voiceConfigRead.current = null;
    };
    let values: Record<string, unknown>;
    try {
      values = await backend.settings("voice");
    } catch (failure) {
      const current = isCurrentVoiceConfigRead();
      releaseVoiceConfigRead();
      if (current)
        toast({
          id: "voice-input",
          tone: "danger",
          title: "Could not read voice settings",
          description:
            failure instanceof Error ? failure.message : String(failure),
          duration: null,
        });
      return;
    }
    if (!isCurrentVoiceConfigRead()) {
      releaseVoiceConfigRead();
      return;
    }
    releaseVoiceConfigRead();
    if (typeof values.api_key_set !== "boolean") {
      toast({
        id: "voice-input",
        tone: "danger",
        title: "Could not read voice settings",
        description: "Voice settings did not include API key status.",
        duration: null,
      });
      return;
    }
    if (!values.api_key_set) {
      showVoiceSettingsToast();
      return;
    }
    releaseSubmission();
    const initial = target.snapshot();
    const revision = initial.draft.bodyRevision;
    const pending = initial.draft.pending;
    const voiceOrigin = initial.draft.voiceSubmission;
    const startsFromSubmission =
      pending?.bodyRevision === revision &&
      initial.draft.body.trim() === pending.body;
    const continuesSubmission = pending && voiceOrigin?.id === pending.id;
    const submission =
      startsFromSubmission || continuesSubmission ? pending : null;
    const submittedBody = submission
      ? startsFromSubmission
        ? initial.draft.body
        : (voiceOrigin?.submittedBody ?? "")
      : "";
    const voiceBase =
      submission && initial.draft.body.startsWith(submittedBody)
        ? initial.draft.body.slice(submittedBody.length)
        : initial.draft.body;
    const session: {
      submittedBody: string;
      voiceBase: string;
      bodyRevision: number;
      submissionId: string | null;
      submissionState: "pending" | "sent" | "cancelled" | null;
    } = {
      submittedBody,
      voiceBase,
      bodyRevision: revision,
      submissionId: submission?.id ?? null,
      submissionState: submission ? "pending" : null,
    };
    if (submission) {
      let unsubscribe!: () => void;
      const updateResult = () => {
        const result = target.snapshot().submissionResult;
        if (result?.id !== submission.id) return;
        session.submissionState = result.state;
        unsubscribe();
        if (submissionUnsubscribe.current === unsubscribe)
          submissionUnsubscribe.current = null;
      };
      unsubscribe = target.subscribe(updateResult);
      submissionUnsubscribe.current = unsubscribe;
      updateResult();
    }
    dismissToast("voice-input");
    const active = new VoiceRecording((event) => {
      if (
        recording.current !== active ||
        currentDraft.current.controller !== target ||
        currentDraft.current.discussionId !== discussionId
      )
        return;
      if (event.type === "state") {
        setVoiceState(event.state);
        if (event.state === "closed") recording.current = null;
      } else if (event.type === "transcript") {
        if (target.snapshot().draft.bodyRevision !== session.bodyRevision) {
          cancelRecording();
          return;
        }
        const snapshot = target.snapshot();
        const retainsSubmission =
          session.submissionId !== null &&
          session.submissionState !== "sent" &&
          snapshot.draft.body.startsWith(session.submittedBody) &&
          (snapshot.draft.pending?.id === session.submissionId ||
            session.submissionState === "cancelled");
        const submittedBody = retainsSubmission ? session.submittedBody : "";
        const text = submittedBody + session.voiceBase + event.text;
        const voiceSubmission =
          session.submissionId !== null &&
          snapshot.draft.pending?.id === session.submissionId &&
          retainsSubmission
            ? { id: session.submissionId, submittedBody }
            : null;
        target.setVoiceBody(text, voiceSubmission);
        session.bodyRevision = target.snapshot().draft.bodyRevision;
        setCaret(text.length);
      } else if (event.type === "error") {
        if (event.code === "voice_config") showVoiceSettingsToast();
        else
          toast({
            id: "voice-input",
            tone: "danger",
            title: "Could not transcribe voice input",
            description: event.message,
            duration: null,
          });
      }
    });
    recording.current = active;
    void active.start();
  };
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const focusDelivered = useRef(false);
  useEffect(() => {
    if (
      !focusOnReady ||
      !controller ||
      !input.current ||
      input.current.matches(":disabled") ||
      focusDelivered.current
    )
      return;
    focusDelivered.current = true;
    input.current.focus();
    onFocused?.();
  }, [focusOnReady, controller, onFocused, busy, view?.busy]);
  const menuId = useId();
  const isTouchOrNarrow = useTouchOrNarrow();
  const wrapper = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const card = useRef<HTMLFieldSetElement>(null);
  const probe = useRef<HTMLTextAreaElement>(null);
  const compactContainer = useRef<HTMLDivElement>(null);
  const topFade = useRef<HTMLDivElement>(null);
  const bottomFade = useRef<HTMLDivElement>(null);
  const updateFades = useCallback(() => {
    const element = input.current;
    if (!element || !topFade.current || !bottomFade.current) return;
    const fades = composerFades(
      element.scrollTop,
      element.scrollHeight,
      element.clientHeight,
    );
    topFade.current.style.opacity = String(fades.top);
    bottomFade.current.style.opacity = String(fades.bottom);
    topFade.current.style.top = `${element.offsetTop}px`;
    bottomFade.current.style.top = `${element.offsetTop + element.offsetHeight - 32}px`;
  }, []);
  const compactPadding = isTouchOrNarrow ? 52 : 44;
  const [layout, setLayout] = useState({
    expanded: false,
    height: 48,
    smooth: false,
  });

  useLayoutEffect(() => {
    const element = input.current;
    const measureInput = probe.current;
    const compactElement = compactContainer.current;
    if (!element || !measureInput || !compactElement) return;
    const measure = (typing = false) => {
      const originalStyle = measureInput.style.cssText;
      const sizing = getComputedStyle(element);
      for (const property of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "fontStretch",
        "fontVariant",
        "fontFeatureSettings",
        "fontVariationSettings",
        "lineHeight",
        "letterSpacing",
        "wordSpacing",
        "textIndent",
        "textTransform",
        "textRendering",
        "direction",
        "whiteSpace",
        "wordBreak",
        "overflowWrap",
        "tabSize",
        "boxSizing",
        "paddingLeft",
        "paddingRight",
        "borderTopWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "borderRightWidth",
        "borderStyle",
      ] as const) {
        measureInput.style[property] = sizing[property];
      }
      measureInput.style.boxSizing = "border-box";
      measureInput.style.width = `${compactElement.clientWidth}px`;
      measureInput.style.paddingBlock = "12px";
      measureInput.style.paddingLeft = `${compactPadding}px`;
      measureInput.style.paddingRight = isTouchOrNarrow ? "52px" : "48px";
      const compactStyle = getComputedStyle(measureInput);
      const compactLine = Number.parseFloat(compactStyle.lineHeight);
      const compactPaddingValue =
        Number.parseFloat(compactStyle.paddingTop) +
        Number.parseFloat(compactStyle.paddingBottom);
      const expanded =
        files.length > 0 ||
        !!view?.draft.pending ||
        recordingActive ||
        composerMultiline(
          element.value,
          measureInput.scrollHeight,
          compactLine,
          compactPaddingValue,
        );
      const scrollTop = element.scrollTop;
      element.style.paddingBlock = expanded ? "14px" : "12px";
      element.style.paddingLeft = `${expanded ? (isTouchOrNarrow ? 14 : 16) : compactPadding}px`;
      element.style.paddingRight = isTouchOrNarrow ? "52px" : "48px";
      const style = getComputedStyle(element);
      const line = Number.parseFloat(style.lineHeight);
      const padding =
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      const border =
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth);
      const horizontalBorder =
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      const scrollbar = Math.max(
        0,
        element.offsetWidth - element.clientWidth - horizontalBorder,
      );
      measureInput.style.width = `${element.getBoundingClientRect().width - scrollbar}px`;
      measureInput.style.paddingBlock = element.style.paddingBlock;
      measureInput.style.paddingLeft = element.style.paddingLeft;
      measureInput.style.paddingRight = element.style.paddingRight;
      const height = expanded
        ? Math.max(
            68,
            autoGrowHeight(measureInput.scrollHeight, line, padding, border, 8),
          )
        : line + padding + border;
      measureInput.style.cssText = originalStyle;
      element.style.height = `${style.boxSizing === "content-box" ? height - padding - border : height}px`;
      element.scrollTop = scrollTop;
      updateFades();
      setLayout((previous) => {
        const nextHeight = composerHeight(expanded, height, isTouchOrNarrow);
        const smooth =
          previous.expanded !== expanded
            ? false
            : typing
              ? true
              : previous.smooth;
        return previous.expanded === expanded &&
          previous.height === nextHeight &&
          previous.smooth === smooth
          ? previous
          : { expanded, height: nextHeight, smooth };
      });
    };
    measure(true);
    let width = element.getBoundingClientRect().width;
    let contentWidth = element.clientWidth;
    let compactWidth = compactElement.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      const nextContentWidth = element.clientWidth;
      const nextCompactWidth = compactElement.getBoundingClientRect().width;
      if (
        nextWidth === width &&
        nextContentWidth === contentWidth &&
        nextCompactWidth === compactWidth
      )
        return;
      width = nextWidth;
      contentWidth = nextContentWidth;
      compactWidth = nextCompactWidth;
      measure();
    });
    observer.observe(element);
    observer.observe(compactElement);
    let mounted = true;
    void document.fonts.ready.then(() => {
      if (mounted) measure();
    });
    return () => {
      mounted = false;
      observer.disconnect();
    };
  }, [
    body,
    files.length,
    view?.draft.pending,
    extraHeight,
    recordingActive,
    updateFades,
    compactPadding,
    isTouchOrNarrow,
  ]);

  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    let height = -1;
    const update = () => {
      const next = element.getBoundingClientRect().height;
      if (height === next) return;
      height = next;
      onHeightChange(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);

  const mention = mentionQuery(body, caret);
  const grouped = useMemo(
    () =>
      mention
        ? candidatesFor(members, memberIds, mention.query)
        : { hasAll: false, inDiscussion: [], elsewhere: [] },
    [mention, members, memberIds],
  );

  const candidates: MentionCandidate[] = [
    ...(grouped.hasAll
      ? [{ kind: "all" as const, id: "all" as const, name: "all" as const }]
      : []),
    ...[...grouped.inDiscussion, ...grouped.elsewhere].map((member) => ({
      kind: "member" as const,
      id: member.id,
      name: member.name,
      member,
    })),
  ].slice(0, MENU_LIMIT);
  const suggesting = mention !== null && candidates.length > 0 && !dismissed;
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>(
    undefined,
  );

  const updateMenuHeight = useCallback(() => {
    if (!card.current) return;
    const rect = card.current.getBoundingClientRect();
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const vvTop = vv ? vv.offsetTop : 0;
    const available = Math.max(0, rect.top - vvTop - 8);
    const clamped = Math.min(264, available);
    setMenuMaxHeight(clamped);
  }, []);

  useLayoutEffect(() => {
    if (!suggesting) return;
    updateMenuHeight();
    const cardElement = card.current;
    let observer: ResizeObserver | null = null;
    if (cardElement) {
      observer = new ResizeObserver(updateMenuHeight);
      observer.observe(cardElement);
    }
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    window.addEventListener("resize", updateMenuHeight);
    window.addEventListener("scroll", updateMenuHeight, true);
    if (vv) {
      vv.addEventListener("resize", updateMenuHeight);
      vv.addEventListener("scroll", updateMenuHeight);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateMenuHeight);
      window.removeEventListener("scroll", updateMenuHeight, true);
      if (vv) {
        vv.removeEventListener("resize", updateMenuHeight);
        vv.removeEventListener("scroll", updateMenuHeight);
      }
    };
  }, [
    suggesting,
    updateMenuHeight,
    layout.height,
    extraHeight,
    keyboardOffset,
  ]);
  const active = candidates.length > 0 ? highlighted % candidates.length : 0;
  const elsewhereFrom = Math.min(
    Number(grouped.hasAll) + grouped.inDiscussion.length,
    candidates.length,
  );

  const accept = (candidate: MentionCandidate) => {
    if (!mention) return;
    const next = completeMention(body, mention, caret, candidate.name);
    cancelRecording();
    setBody(next.text);
    setCaret(next.caret);
    setHighlighted(0);
    setDismissed(true);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = async () => {
    if (disabled || !canSend || sending || !controller || recording.current)
      return;
    await controller.send(onSend);
    if (!controller.snapshot().draft.body) setCaret(0);
  };
  const pending = view?.moved ? null : (view?.draft.pending ?? null);
  const pendingError = pending && view?.error ? view.error : null;
  const draftFailure =
    draftError ??
    view?.storageError ??
    (pending ? null : (view?.error ?? null));
  const confirmedSend =
    pending !== null &&
    view?.submissionResult?.id === pending.id &&
    view.submissionResult.state === "sent";
  const confirmedCancellation =
    pending !== null &&
    view?.submissionResult?.id === pending.id &&
    view.submissionResult.state === "cancelled";
  const pendingNames = pending?.files.map((item) => item.file.name) ?? [];

  return (
    <div
      ref={wrapper}
      style={{
        bottom: keyboardOffset,
      }}
      className="pointer-events-none absolute inset-x-4 flex justify-center pb-4 narrow:inset-x-2 narrow:pb-[calc(8px+env(safe-area-inset-bottom,0px))]"
    >
      <div
        ref={compactContainer}
        className="invisible pointer-events-none absolute top-0 w-full @[601px]:w-3/4 border border-transparent"
        aria-hidden="true"
      >
        <Textarea
          ref={probe}
          variant="composer"
          style={{
            position: "absolute",
            height: "auto",
            minHeight: 0,
            maxHeight: "none",
            overflow: "hidden",
            paddingLeft: compactPadding,
          }}
          value={body}
          readOnly
          rows={1}
          tabIndex={-1}
        />
      </div>
      <fieldset
        ref={card}
        aria-label="Message composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          controller?.addFiles(Array.from(event.dataTransfer.files));
        }}
        data-expanded={layout.expanded}
        className={clsx(
          "pointer-events-auto relative flex flex-col min-h-0 w-full rounded-[24px] border border-line bg-surface text-fg shadow-[0_1px_3px_0_rgb(0_0_0/0.1),0_1px_2px_-1px_rgb(0_0_0/0.1)] focus-within:border-line-hover hover:border-line-interactive transition-[width,height] motion-reduce:transition-none narrow:max-h-[35dvh] touch:max-h-[35dvh]",
          layout.expanded ? "@[601px]:w-[90%]" : "@[601px]:w-3/4",
        )}
        style={{
          height: layout.height + extraHeight,
          transitionDuration: layout.smooth ? "0.4s, 0.15s" : "0.4s, 0.4s",
          transitionTimingFunction: layout.smooth
            ? "cubic-bezier(0.175,0.885,0.32,1.275), ease-out"
            : "cubic-bezier(0.175,0.885,0.32,1.275)",
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Choose attachments"
          onChange={(event) => {
            controller?.addFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <div
          ref={extra}
          className="shrink-0 overflow-y-auto narrow:max-h-[14dvh]"
        >
          {files.length ? (
            <DraftAttachments
              files={files}
              onRemove={(id) => controller?.removeFile(id)}
            />
          ) : null}
          {view?.recoveryCandidate && !view.moved ? (
            <div className="px-4 pt-3 text-sm" role="status">
              <button
                type="button"
                className="underline"
                disabled={view.busy || view.saving}
                onClick={() => void controller?.recover()}
              >
                Recover saved draft
              </button>
              <div className="mt-1 text-xs text-fg-muted">
                Saved{" "}
                {new Date(view.recoveryCandidate.updatedAt).toLocaleString()}.
                This moves the saved draft to this tab. Stop sending in other
                tabs first.
              </div>
            </div>
          ) : null}
          {draftFailure ? (
            <div role="alert" className="px-4 pt-3 text-sm text-red-300">
              {draftFailure}
              {view?.storageError && !view.moved ? (
                <button
                  type="button"
                  className="ml-2 underline"
                  disabled={view.recovering || view.saving}
                  onClick={() => controller?.saveAgain()}
                >
                  Retry saving draft
                </button>
              ) : null}
              {draftError ? (
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={retryDraft}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {pending &&
          sending &&
          pending.phase === "uploading" &&
          !pending.cancelRequested ? (
            <div className="px-4 pt-2 text-xs">
              <button
                type="button"
                className="underline"
                onClick={() => controller?.cancel()}
              >
                Cancel upload
              </button>
            </div>
          ) : null}
          {pending && !sending ? (
            <div className="px-4 pt-2 text-xs">
              <div className="font-medium">
                {pending.cancelRequested
                  ? pending.phase === "uploading"
                    ? "Cancelling upload"
                    : "Cancelling send"
                  : "Pending message"}
              </div>
              <div className="mt-1 truncate">
                {pending.body || (pendingNames.length ? "" : "Files")}
              </div>
              {pendingNames.length ? (
                <div className="mt-1 truncate text-fg-muted">
                  {pendingNames.join(", ")}
                </div>
              ) : null}
              {pendingError ? (
                <div role="alert" className="mt-2 text-red-300">
                  {confirmedSend ? "Could not update draft" : pendingError}
                </div>
              ) : null}
              {pending.cancelRequested ? (
                pendingError ? (
                  <div className="mt-2 flex flex-wrap gap-3">
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void controller?.checkResult()}
                    >
                      Retry
                    </button>
                  </div>
                ) : null
              ) : (
                <div className="mt-2 flex flex-wrap gap-3">
                  {confirmedSend || confirmedCancellation ? (
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void controller?.checkResult()}
                    >
                      Retry
                    </button>
                  ) : (
                    <>
                      {pending.phase === "sending" ? (
                        <button
                          type="button"
                          className="underline"
                          onClick={() => void controller?.checkResult()}
                        >
                          Check result
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="underline"
                        disabled={disabled}
                        onClick={() => void submit()}
                      >
                        Retry send
                      </button>
                      <button
                        type="button"
                        className="underline"
                        onClick={() => void controller?.discardAttempt()}
                      >
                        Cancel send
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
        {suggesting ? (
          <div
            className="absolute bottom-full mb-2 left-0 right-0 z-(--layer-popover) max-h-66 overflow-y-auto rounded-sm bg-surface-raised p-1 shadow-popover origin-bottom animate-pop-in"
            style={{
              maxHeight:
                menuMaxHeight !== undefined ? `${menuMaxHeight}px` : undefined,
            }}
            id={menuId}
            role="listbox"
            aria-label="Members"
          >
            {candidates.map((candidate, index) => {
              const inside =
                candidate.kind === "all" || memberIds.has(candidate.id);
              return (
                <Fragment key={candidate.id}>
                  {index === elsewhereFrom && index > 0 ? (
                    <div
                      className="mt-1 border-t border-line px-2 pt-3 pb-1 text-xs text-fg-muted"
                      role="presentation"
                    >
                      Not in this Discussion
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={clsx(
                      "flex w-full items-center gap-2 rounded-xs border-0 px-2 py-1 narrow:min-h-11 touch:min-h-11 text-left text-inherit cursor-pointer transition-[background-color] duration-(--duration-fast) ease-linear hover:bg-surface-hover",
                      index === active
                        ? "bg-surface-hover shadow-[inset_2px_0_0_var(--color-blue-300)]"
                        : "bg-transparent",
                    )}
                    role="option"
                    id={`${menuId}-${candidate.id}`}
                    aria-selected={index === active}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      accept(candidate);
                    }}
                    onTouchStart={(event) => {
                      const touch = event.touches[0];
                      touchStart.current = {
                        x: touch.clientX,
                        y: touch.clientY,
                      };
                    }}
                    onTouchEnd={(event) => {
                      if (!touchStart.current) return;
                      const touch = event.changedTouches[0];
                      const dx = Math.abs(touch.clientX - touchStart.current.x);
                      const dy = Math.abs(touch.clientY - touchStart.current.y);
                      touchStart.current = null;
                      if (dx < 10 && dy < 10) {
                        event.preventDefault();
                        accept(candidate);
                      }
                    }}
                  >
                    {candidate.kind === "all" ? (
                      <span className="size-[22px] rounded-sm bg-surface inline-flex items-center justify-center flex-none text-fg-muted select-none">
                        <EveryoneIcon />
                      </span>
                    ) : (
                      <Avatar memberId={candidate.id} size="sm" />
                    )}
                    <span
                      className={clsx(
                        "min-w-0 flex-1 truncate",
                        inside ? "font-medium" : "font-normal text-fg-muted",
                      )}
                    >
                      {candidate.name}
                    </span>
                    {inside ? (
                      <span className="flex-none text-xs text-fg-muted">
                        {candidate.kind === "all"
                          ? "Everyone"
                          : candidate.member.type === "human"
                            ? "Human"
                            : candidate.member.state}
                      </span>
                    ) : null}
                  </button>
                </Fragment>
              );
            })}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 min-h-0 overflow-hidden">
          <Textarea
            ref={input}
            value={body}
            readOnly={view?.moved}
            disabled={!controller || !!view?.recovering}
            style={{
              paddingLeft: layout.expanded
                ? isTouchOrNarrow
                  ? 14
                  : undefined
                : compactPadding,
              paddingRight: isTouchOrNarrow ? 52 : undefined,
              maxHeight: "100%",
            }}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (!images.length) return;
              if (!event.clipboardData.getData("text/plain"))
                event.preventDefault();
              controller?.addFiles(images);
            }}
            rows={1}
            variant="composer"
            onScroll={updateFades}
            placeholder={placeholder}
            aria-label="Message"
            role="combobox"
            aria-expanded={suggesting}
            aria-controls={suggesting ? menuId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              suggesting ? `${menuId}-${candidates[active].id}` : undefined
            }
            onChange={(event) => {
              cancelRecording();
              setBody(event.target.value);
              setCaret(event.target.selectionStart ?? 0);
              setHighlighted(0);
              setDismissed(false);
            }}
            onSelect={(event) =>
              setCaret(event.currentTarget.selectionStart ?? 0)
            }
            onKeyDown={(event) => {
              const action = composerKey(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  isComposing: event.nativeEvent.isComposing,
                },
                suggesting,
              );
              if (action === null || action === "newline") return;
              event.preventDefault();
              const size = candidates.length;
              switch (action) {
                case "down":
                  setHighlighted((current) => (current + 1) % size);
                  break;
                case "up":
                  setHighlighted((current) => (current - 1 + size) % size);
                  break;
                case "accept":
                  accept(candidates[active]);
                  break;
                case "dismiss":
                  setDismissed(true);
                  break;
                case "send":
                  void submit();
                  break;
              }
            }}
          />
        </div>
        <div
          ref={topFade}
          aria-hidden="true"
          className="pointer-events-none absolute left-4 right-12 top-0 z-[2] h-8 bg-gradient-to-b from-surface via-surface/90 to-transparent"
          style={{ opacity: 0 }}
        />
        <div
          ref={bottomFade}
          aria-hidden="true"
          className="pointer-events-none absolute left-4 right-12 z-[2] h-8 bg-gradient-to-t from-surface via-surface/90 to-transparent"
          style={{ opacity: 0 }}
        />
        <div
          aria-hidden={!layout.expanded}
          inert={!layout.expanded ? true : undefined}
          className={clsx(
            "absolute bottom-2 left-3 right-12 narrow:right-14 touch:right-14 z-10 flex min-w-0 items-center gap-0 transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] motion-reduce:transition-none",
            layout.expanded
              ? "opacity-100 blur-0 translate-y-0 pointer-events-auto"
              : "opacity-0 blur-sm translate-y-2 pointer-events-none",
          )}
        >
          <button
            type="button"
            disabled={!controller || !!view?.recovering || !!view?.moved}
            onClick={() => fileInput.current?.click()}
            aria-label="Attach files"
            title="Attach files"
            className="ml-auto flex size-7 narrow:size-11 narrow:min-w-11 narrow:min-h-11 touch:size-11 touch:min-w-11 touch:min-h-11 flex-none items-center justify-center rounded-full text-fg-muted hover:bg-surface-hover outline-none cursor-default disabled:opacity-40"
          >
            <PlusIcon />
          </button>
        </div>
        {!layout.expanded ? (
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={!controller || !!view?.recovering || !!view?.moved}
            onClick={() => fileInput.current?.click()}
            className="absolute left-2 bottom-2 narrow:left-1 narrow:bottom-1 touch:left-1 touch:bottom-1 z-10 flex size-8 narrow:size-11 narrow:min-w-11 narrow:min-h-11 touch:size-11 touch:min-w-11 touch:min-h-11 items-center justify-center rounded-full text-fg-muted hover:bg-surface-hover"
          >
            <PlusIcon />
          </button>
        ) : null}
        <button
          type="button"
          className="absolute right-2 bottom-2 narrow:right-1 narrow:bottom-1 touch:right-1 touch:bottom-1 z-10 flex size-8 narrow:size-11 narrow:min-w-11 narrow:min-h-11 touch:size-11 touch:min-w-11 touch:min-h-11 items-center justify-center rounded-full bg-blue-500 text-gray-0 transition-all duration-300 hover:enabled:bg-blue-300 active:enabled:bg-blue-700 outline-none focus-visible:bg-blue-300 cursor-default motion-reduce:transition-none"
          aria-label={
            recordingActive
              ? "Stop recording"
              : canSend
                ? "Send · Enter"
                : "Start voice input"
          }
          title={
            recordingActive
              ? "Stop recording"
              : canSend
                ? "Send · Enter"
                : "Start voice input"
          }
          disabled={
            !controller ||
            !!view?.moved ||
            !!view?.recovering ||
            !!view?.draft.pending?.cancelRequested ||
            (!recordingActive && (sending || disabled)) ||
            voiceState === "finishing"
          }
          onClick={() => {
            if (recordingActive) recording.current?.stop();
            else if (canSend) void submit();
            else void startRecording();
          }}
        >
          {recordingActive ? (
            voiceState === "starting" || voiceState === "finishing" ? (
              <Spinner
                label={
                  voiceState === "finishing"
                    ? "Transcribing"
                    : "Starting microphone"
                }
              />
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <rect width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            )
          ) : sending ? (
            <Spinner label="Sending message" />
          ) : (
            <span
              className="relative flex h-full w-full items-center justify-center"
              aria-hidden="true"
            >
              <span
                className={clsx(
                  "absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] motion-reduce:transition-none",
                  canSend
                    ? "opacity-100 scale-100 rotate-0 blur-none"
                    : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none",
                )}
              >
                <ArrowUpIcon />
              </span>
              <span
                className={clsx(
                  "absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] motion-reduce:transition-none",
                  canSend
                    ? "opacity-0 scale-50 -rotate-45 blur-[1px] pointer-events-none"
                    : "opacity-100 scale-100 rotate-0 blur-none",
                )}
              >
                <MicIcon />
              </span>
            </span>
          )}
        </button>
      </fieldset>
    </div>
  );
}
