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

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-(--layer-overlay) bg-gray-1100/60 animate-fade-in [animation-duration:var(--duration-fast)] [animation-timing-function:var(--ease-out)]" />
        <Dialog.Content
          ref={content}
          className={
            side === "left"
              ? "fixed inset-y-0 left-0 z-(--layer-dialog) flex min-h-0 w-[280px] max-w-[85vw] flex-col border-r border-line bg-app shadow-dialog animate-fade-in"
              : `fixed top-1/2 left-1/2 z-(--layer-dialog) flex min-h-0 max-h-[calc(100vh-32px)] flex-col gap-4 p-6 border border-line rounded-lg bg-surface-raised shadow-dialog [translate:-50%_-50%] origin-center animate-pop-in max-[640px]:inset-x-0 max-[640px]:bottom-0 max-[640px]:top-auto max-[640px]:translate-x-0 max-[640px]:translate-y-0 max-[640px]:w-full max-[640px]:max-w-full max-[640px]:rounded-t-lg max-[640px]:rounded-b-none max-[640px]:border-t max-[640px]:border-x-0 max-[640px]:border-b-0 max-[640px]:max-h-[85dvh] max-[640px]:p-4 max-[640px]:pb-[calc(16px+env(safe-area-inset-bottom))] max-[640px]:animate-slide-up ${wide ? "w-[min(960px,calc(100vw-32px))]" : "w-[min(440px,calc(100vw-48px))]"}`
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
                ? "flex items-center justify-between gap-3 p-3 border-b border-line"
                : "flex items-start justify-between gap-3"
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
              >
                <X size={15} />
              </IconButton>
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="-mt-4 mx-0 mb-0 text-fg-muted text-sm">
              {description}
            </Dialog.Description>
          ) : null}
          <div ref={toastHost} className="empty:hidden shrink-0" />
          {children ? (
            <div
              className={
                side === "left"
                  ? "min-h-0 flex-1 flex flex-col"
                  : "min-h-0 flex-1 overflow-y-auto flex flex-col gap-4"
              }
            >
              {children}
            </div>
          ) : null}
          {footer ? (
            <div
              ref={footerElement}
              className="flex justify-end gap-2 max-[640px]:flex-col-reverse max-[640px]:*:w-full"
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
