import { clsx } from "clsx";
import { MoreHorizontal } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const MENU_WIDTH = 168;

function gapSize(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    "--spacing",
  );
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 4;
}

const menuItemTones = {
  default: "text-fg disabled:text-fg-disabled hover:enabled:bg-surface-hover",
  danger: "text-danger hover:enabled:bg-red-500/20 hover:enabled:text-red-100",
};

export type MenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect: () => void;
};

export function OverflowMenu({
  label,
  actions,
  align = "end",
  icon,
  stopPropagation = false,
  triggerClassName,
}: {
  label: string;
  actions: MenuAction[];
  align?: "start" | "end";
  icon?: ReactNode;
  stopPropagation?: boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [above, setAbove] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const place = useCallback(() => {
    const anchor = trigger.current;
    if (anchor === null) return;
    const rect = anchor.getBoundingClientRect();
    const width = list.current?.offsetWidth ?? MENU_WIDTH;
    const height = list.current?.offsetHeight ?? 0;
    const gap = gapSize();
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const flip = height > spaceBelow && spaceAbove > spaceBelow;
    const top = flip
      ? Math.max(gap, rect.top - gap - height)
      : Math.min(
          rect.bottom + gap,
          Math.max(gap, window.innerHeight - height - gap),
        );
    const raw = align === "end" ? rect.right - width : rect.left;
    const left = Math.max(gap, Math.min(raw, window.innerWidth - width - gap));
    setAbove(flip);
    setPosition({ top, left });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      setAbove(false);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target)) return;
      if (list.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || position === null) return;
    const frame = requestAnimationFrame(() => {
      const buttons = list.current?.querySelectorAll("button");
      buttons?.[active]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active, position]);

  if (actions.length === 0) return null;

  const step = (delta: number) => {
    setActive((current) => {
      const size = actions.length;
      let next = current;
      for (let hop = 0; hop < size; hop += 1) {
        next = (next + delta + size) % size;
        if (!actions[next].disabled) return next;
      }
      return current;
    });
  };

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        className={clsx(
          "inline-flex items-center justify-center size-7 narrow:size-11 narrow:min-w-11 narrow:min-h-11 touch:size-11 touch:min-w-11 touch:min-h-11 border border-transparent rounded-sm bg-transparent text-fg-muted cursor-pointer transition-[background-color,border-color,color] duration-(--duration-fast) ease-linear hover:bg-surface-hover hover:border-line-interactive hover:text-fg aria-expanded:bg-surface-hover aria-expanded:border-line-interactive aria-expanded:text-fg",
          triggerClassName,
        )}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onPointerDown={
          stopPropagation ? (event) => event.stopPropagation() : undefined
        }
        onClick={() => {
          setActive(actions.findIndex((action) => !action.disabled));
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(actions.findIndex((action) => !action.disabled));
            setOpen(true);
          }
          if (open && (event.key === "Escape" || event.key === "Tab"))
            setOpen(false);
        }}
      >
        {icon ?? <MoreHorizontal size={16} />}
      </button>
      {open
        ? createPortal(
            <div
              className={clsx(
                "fixed z-(--layer-menu) min-w-42 p-1 rounded-sm bg-surface-raised shadow-popover animate-pop-in",
                above
                  ? align === "end"
                    ? "origin-bottom-right"
                    : "origin-bottom-left"
                  : align === "end"
                    ? "origin-top-right"
                    : "origin-top-left",
              )}
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                visibility: position === null ? "hidden" : "visible",
              }}
              id={menuId}
              ref={list}
              role="menu"
              aria-label={label}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  step(1);
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  step(-1);
                }
                if (event.key === "Tab") setOpen(false);
              }}
            >
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className={clsx(
                    "flex items-center gap-2 w-full h-7 narrow:min-h-11 touch:min-h-11 py-0 px-2 border-0 rounded-xs bg-transparent text-sm text-left whitespace-nowrap cursor-pointer transition-[background-color,color] duration-(--duration-fast) ease-linear focus-visible:bg-surface-hover disabled:cursor-not-allowed",
                    menuItemTones[action.tone ?? "default"],
                  )}
                  disabled={action.disabled}
                  onClick={() => {
                    close();
                    action.onSelect();
                  }}
                >
                  {action.icon ? (
                    <span className="flex text-fg-muted" aria-hidden="true">
                      {action.icon}
                    </span>
                  ) : null}
                  {action.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
