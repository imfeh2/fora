import { clsx } from "clsx";
import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

const menuAlignments = {
  end: "right-0 origin-top-right",
  start: "left-0 origin-top-left",
};

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
}: {
  label: string;
  actions: MenuAction[];
  align?: "start" | "end";
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const buttons = list.current?.querySelectorAll("button");
    buttons?.[active]?.focus();
  }, [open, active]);

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

  return (
    <div className="relative inline-flex" ref={wrapper}>
      <button
        type="button"
        className="inline-flex items-center justify-center size-7 narrow:size-11 narrow:min-w-11 narrow:min-h-11 touch:size-11 touch:min-w-11 touch:min-h-11 border border-transparent rounded-sm bg-transparent text-fg-muted cursor-pointer transition-[background-color,border-color,color] duration-(--duration-fast) ease-linear hover:bg-surface-hover hover:border-line-interactive hover:text-fg aria-expanded:bg-surface-hover aria-expanded:border-line-interactive aria-expanded:text-fg"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
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
      {open ? (
        <div
          className={clsx(
            "absolute top-[calc(100%+var(--spacing))] z-(--layer-menu) min-w-42 p-1 rounded-sm bg-surface-raised shadow-popover animate-pop-in",
            menuAlignments[align],
          )}
          id={menuId}
          ref={list}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              wrapper.current?.querySelector("button")?.focus();
            }
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
                setOpen(false);
                wrapper.current?.querySelector("button")?.focus();
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
        </div>
      ) : null}
    </div>
  );
}
