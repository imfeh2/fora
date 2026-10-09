import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-(--layer-overlay) bg-gray-1100/60 animate-fade-in [animation-duration:var(--duration-fast)] [animation-timing-function:var(--ease-out)]" />
        <Dialog.Content
          ref={content}
          className={
            side === "left"
              ? "fixed inset-y-0 left-0 z-(--layer-dialog) flex min-h-0 w-[280px] max-w-[85vw] flex-col border-r border-line bg-app shadow-dialog animate-fade-in"
              : `fixed top-1/2 left-1/2 z-(--layer-dialog) flex min-h-0 max-h-[calc(100vh-32px)] flex-col gap-4 p-6 border border-line rounded-lg bg-surface-raised shadow-dialog [translate:-50%_-50%] origin-center animate-pop-in narrow:inset-x-0 narrow:bottom-0 narrow:top-auto narrow:translate-x-0 narrow:translate-y-0 narrow:w-full narrow:max-w-full narrow:rounded-t-lg narrow:rounded-b-none narrow:border-t narrow:border-x-0 narrow:border-b-0 ${maxDvhClass} narrow:p-4 narrow:pb-[calc(16px+env(safe-area-inset-bottom,0px))] narrow:animate-slide-up ${wideWidth}`
          }
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
          <div
            className={
              side === "left"
                ? "flex items-center justify-between gap-3 p-3 border-b border-line shrink-0"
                : "flex items-start justify-between gap-3 shrink-0"
            }
          >
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
          <div ref={toastHost} className="empty:hidden shrink-0" />
          {side === "left" ? (
            children ? (
              <div className="min-h-0 flex-1 flex flex-col">{children}</div>
            ) : null
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto flex flex-col gap-4">
              {description ? (
                <Dialog.Description className="mx-0 mb-0 text-fg-muted text-sm shrink-0">
                  {description}
                </Dialog.Description>
              ) : null}
              {children}
            </div>
          )}
          {footer ? (
            <div
              ref={footerElement}
              className="flex justify-end gap-2 shrink-0 narrow:flex-col-reverse narrow:*:w-full narrow:*:min-h-11 touch:flex-col-reverse touch:*:w-full touch:*:min-h-11"
            >
              {footer}
            </div>
          ) : null}
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
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const submitted = trim ? value.trim() : value;
  const error = validate?.(submitted);

  const commit = async () => {
    if (!submitted || error || busy) return;
    setBusy(true);
    try {
      await onSubmit(submitted);
      onOpenChange(false);
    } catch (failure) {
      reportFailure(`Could not ${submitLabel.toLowerCase()}`, failure);
      refocus(input.current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      variant="form"
      description={description}
      footer={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>
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
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => setValue(event.target.value)}
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
