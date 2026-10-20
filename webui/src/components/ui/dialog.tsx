import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button, Field, IconButton, Input, toast } from "@/components/ui/index";
import { registerToastHost } from "@/components/ui/toast-host";

export function dialogFocusTarget<
  T extends { disabled?: boolean },
  U extends { disabled?: boolean },
>(fields: T[], buttons: U[]): T | U | null {
  const field = fields.find((item) => !item.disabled);
  if (field) return field;
  const enabled = buttons.filter((item) => !item.disabled);
  return enabled.length > 0 ? enabled[enabled.length - 1] : null;
}

function reportFailure(title: string, failure: unknown) {
  toast({
    tone: "danger",
    title,
    description: failure instanceof Error ? failure.message : String(failure),
  });
}

function refocus(target: { focus: () => void } | null) {
  requestAnimationFrame(() => {
    if (document.activeElement === document.body) target?.focus();
  });
}

export type ModalVariant = "form" | "confirm" | "history";

const FooterSlot = createContext<HTMLDivElement | null>(null);

export function ModalFooter({ children }: { children: ReactNode }) {
  const node = useContext(FooterSlot);
  if (!node) return <>{children}</>;
  return createPortal(children, node);
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  footerSlot = false,
  tone = "dialog",
  wide = false,
  variant,
  side,
  initialFocus,
  restoreFocus,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  footerSlot?: boolean;
  tone?: "dialog" | "surface";
  wide?: boolean;
  variant?: ModalVariant;
  side?: "left";
  initialFocus?: () => HTMLElement | null;
  restoreFocus?: () => HTMLElement | null;
  onClosed?: () => void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const footerElement = useRef<HTMLDivElement>(null);
  const [footerNode, setFooterNode] = useState<HTMLDivElement | null>(null);
  const attachFooter = useCallback((node: HTMLDivElement | null) => {
    footerElement.current = node;
    setFooterNode(node);
  }, []);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  const isOpen = useRef(open);
  isOpen.current = open;
  const toastHost = useCallback((node: HTMLDivElement | null) => {
    if (node) return registerToastHost(node);
  }, []);

  const modalKind = variant ?? "form";
  const maxDvhClass =
    modalKind === "confirm"
      ? ""
      : modalKind === "history"
        ? "narrow:max-h-[90dvh]"
        : "narrow:max-h-[85dvh]";
  const wideWidth = wide
    ? "w-[min(960px,calc(100vw-32px))]"
    : "w-[min(440px,calc(100vw-48px))]";
  const framed = tone === "surface";
  const spacing = framed
    ? "gap-4 p-6 narrow:p-4 narrow:pb-[calc(16px+env(safe-area-inset-bottom,0px))]"
    : "";
  const headerSpacing = framed ? "" : "px-6 pt-5 pb-4 narrow:px-4 narrow:pt-4";
  const headerDivider =
    framed || modalKind === "confirm" ? "" : "border-b border-line";
  const bodySpacing = framed
    ? ""
    : `px-6 py-5 narrow:px-4 narrow:py-4${
        footer || footerSlot
          ? ""
          : " narrow:pb-[calc(16px+env(safe-area-inset-bottom,0px))]"
      }`;
  const footerSpacing = framed
    ? ""
    : "px-6 pt-4 pb-5 narrow:px-4 narrow:pt-4 narrow:pb-[calc(16px+env(safe-area-inset-bottom,0px))]";
  const footerDivider =
    framed ||
    modalKind === "confirm" ||
    (modalKind === "history" && !footer && !footerSlot)
      ? ""
      : "border-t border-line";
  const panelClass =
    side === "left"
      ? "dialog-panel fixed inset-y-0 left-0 z-(--layer-dialog) flex min-h-0 w-[280px] max-w-[85vw] flex-col border-r border-line rounded-r-lg bg-surface-dialog shadow-dialog animate-fade-in"
      : `dialog-panel fixed top-1/2 left-1/2 z-(--layer-dialog) flex min-h-0 max-h-[calc(100vh-32px)] flex-col ${spacing} border border-line rounded-lg ${framed ? "bg-surface" : "bg-surface-dialog"} shadow-dialog [translate:-50%_-50%] origin-center animate-pop-in narrow:inset-x-0 narrow:bottom-0 narrow:top-auto narrow:translate-x-0 narrow:translate-y-0 narrow:w-full narrow:max-w-full narrow:rounded-t-lg narrow:rounded-b-none narrow:border-t narrow:border-x-0 narrow:border-b-0 ${maxDvhClass} narrow:animate-slide-up ${wideWidth}`;
  const headerClass =
    side === "left"
      ? "flex items-center justify-between gap-3 p-3 border-b border-line shrink-0"
      : `flex items-start justify-between gap-3 shrink-0 ${headerSpacing} ${headerDivider}`;
  const footerClass = `flex justify-end gap-2 shrink-0 ${footerSpacing} ${footerDivider} narrow:flex-col-reverse narrow:*:w-full narrow:*:min-h-11 touch:flex-col-reverse touch:*:w-full touch:*:min-h-11`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-(--layer-overlay) bg-gray-1100/60 animate-fade-in [animation-duration:var(--duration-fast)] [animation-timing-function:var(--ease-out)]" />
        <Dialog.Content
          ref={content}
          className={panelClass}
          onOpenAutoFocus={(event) => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            event.preventDefault();
            const root = content.current;
            if (!root) return;
            const target = initialFocus
              ? initialFocus()
              : side === "left"
                ? closeButton.current
                : dialogFocusTarget(
                    Array.from(
                      root.querySelectorAll<
                        | HTMLInputElement
                        | HTMLTextAreaElement
                        | HTMLSelectElement
                      >("input, textarea, select"),
                    ),
                    Array.from(
                      footerElement.current?.querySelectorAll<HTMLButtonElement>(
                        "button",
                      ) ?? [],
                    ),
                  );
            (target ?? root).focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = restoreFocus ? restoreFocus() : opener.current;
            target?.focus();
            if (!isOpen.current) closed.current?.();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className={headerClass}>
            <Dialog.Title className="min-w-0 wrap-anywhere m-0 text-md font-semibold tracking-title">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton
                ref={closeButton}
                label={side === "left" ? "Close navigation" : "Close"}
                size="sm"
                touchTarget
              >
                <X size={15} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div
            ref={toastHost}
            className={`empty:hidden shrink-0 ${framed ? "" : "px-6 narrow:px-4"}`}
          />
          <FooterSlot.Provider value={footerNode}>
            {side === "left" ? (
              children ? (
                <div className="min-h-0 flex-1 flex flex-col">{children}</div>
              ) : null
            ) : (
              <div
                className={`min-h-0 flex-1 overflow-y-auto flex flex-col gap-4 ${bodySpacing}`}
              >
                {description ? (
                  <Dialog.Description className="mx-0 mb-0 text-fg-muted text-sm shrink-0">
                    {description}
                  </Dialog.Description>
                ) : null}
                {children}
              </div>
            )}
            {footer || footerSlot ? (
              <div ref={attachFooter} className={footerClass}>
                {footer}
              </div>
            ) : null}
          </FooterSlot.Provider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PromptDialog({
  open,
  onOpenChange,
  title,
  label,
  placeholder,
  description,
  validate,
  trim = true,
  initial = "",
  submitLabel,
  onSubmit,
  protectUnsaved = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  placeholder?: string;
  description?: ReactNode;
  validate?: (value: string) => string | undefined;
  trim?: boolean;
  initial?: string;
  submitLabel: string;
  onSubmit: (value: string) => void | Promise<void>;
  protectUnsaved?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const wasOpen = useRef(false);
  const savedValue = useRef(initial);
  const inFlight = useRef(false);

  useEffect(() => {
    if (open && (!protectUnsaved || !wasOpen.current)) {
      savedValue.current = initial;
      setValue(initial);
      setDiscarding(false);
    }
    wasOpen.current = open;
  }, [open, initial, protectUnsaved]);

  const submitted = trim ? value.trim() : value;
  const error = validate?.(submitted);

  const commit = async () => {
    if (!submitted || error || inFlight.current) return;
    inFlight.current = true;
    input.current?.focus();
    setBusy(true);
    try {
      await onSubmit(submitted);
      onOpenChange(false);
    } catch (failure) {
      reportFailure(`Could not ${submitLabel.toLowerCase()}`, failure);
      requestAnimationFrame(() => input.current?.focus());
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const close = () => {
    if (inFlight.current) return;
    if (protectUnsaved && value !== savedValue.current) setDiscarding(true);
    else onOpenChange(false);
  };
  const keepEditing = () => {
    setDiscarding(false);
    requestAnimationFrame(() => input.current?.focus());
  };

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : close())}
        title={title}
        variant="form"
        description={description}
        footer={
          <>
            <Button disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!submitted || !!error || busy}
              onClick={commit}
            >
              {submitLabel}
            </Button>
          </>
        }
      >
        <Field label={label} htmlFor={inputId}>
          <Input
            ref={input}
            id={inputId}
            value={value}
            readOnly={busy}
            placeholder={placeholder}
            aria-invalid={!!error}
            aria-describedby={error ? `${inputId}-error` : undefined}
            onChange={(event) => {
              if (!inFlight.current) setValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
            }}
          />
          {error ? (
            <p
              id={`${inputId}-error`}
              className="text-sm text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </Field>
      </Modal>
      <Modal
        open={open && discarding}
        onOpenChange={(next) => !next && keepEditing()}
        title="Discard unsaved changes?"
        variant="confirm"
        description="You have unsaved modifications."
        footer={
          <>
            <Button onClick={keepEditing}>Keep Editing</Button>
            <Button
              variant="danger"
              onClick={() => {
                setDiscarding(false);
                onOpenChange(false);
              }}
            >
              Discard
            </Button>
          </>
        }
      />
    </>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const action = useRef<HTMLButtonElement>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (failure) {
      reportFailure(`Could not ${confirmLabel.toLowerCase()}`, failure);
      refocus(action.current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      variant="confirm"
      description={description}
      footer={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            ref={action}
            variant="danger"
            disabled={busy}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
