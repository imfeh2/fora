import { clsx } from "clsx";
import { ArrowLeft, Menu } from "lucide-react";
import {
  Children,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Modal } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/index";
import brandIcon from "../../../../assets/icon.svg";

const crumbClasses =
  "inline-flex items-center gap-1 self-start min-h-6 py-0 pr-2 pl-1 border-0 rounded-xs bg-transparent text-fg-muted text-xs font-medium cursor-pointer transition-[background-color,color] duration-(--duration-fast) ease-linear hover:bg-surface-raised hover:text-fg";

const pageBodyVariants = {
  scroll:
    "gap-4 overflow-y-auto pt-0 px-8 pb-8 max-[940px]:px-6 narrow:px-3 narrow:pb-4",
  flush: "gap-0 overflow-hidden",
};

const columnVisibility = {
  md: "max-[1120px]:hidden",
  sm: "max-[940px]:hidden",
};

const badgeSlot = "flex min-w-5 flex-none items-center justify-end";
const trailingSlot = "flex w-[26px] flex-none items-center justify-center";

const SIDEBAR_WIDTH_DEFAULT = 240;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 400;
const SIDEBAR_WIDTH_STEP = 16;
const SIDEBAR_WIDTH_KEY = "fora.sidebar-width";

function clampSidebarWidth(value: number): number {
  return Math.min(
    Math.max(Math.round(value), SIDEBAR_WIDTH_MIN),
    SIDEBAR_WIDTH_MAX,
  );
}

function readSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_WIDTH_DEFAULT;
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampSidebarWidth(stored)
    : SIDEBAR_WIDTH_DEFAULT;
}

function writeSidebarWidth(width: number) {
  window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
}

function subscribeViewport(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

function subscribeTouchOrNarrow(listener: () => void) {
  const mqlCoarse =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(pointer: coarse)")
      : null;
  window.addEventListener("resize", listener);
  mqlCoarse?.addEventListener?.("change", listener);
  return () => {
    window.removeEventListener("resize", listener);
    mqlCoarse?.removeEventListener?.("change", listener);
  };
}

function getTouchOrNarrowSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  const isNarrow = window.innerWidth <= 640;
  const isCoarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return isNarrow || isCoarse;
}

export function useNarrowViewport() {
  return useSyncExternalStore(
    subscribeViewport,
    () => window.innerWidth <= 640,
    () => false,
  );
}

export function useTouchOrNarrow(): boolean {
  return useSyncExternalStore(
    subscribeTouchOrNarrow,
    getTouchOrNarrowSnapshot,
    () => false,
  );
}

export function Shell({
  sidebar,
  children,
  navigation,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  navigation?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onClosed: () => void;
    trigger: RefObject<HTMLButtonElement | null>;
    restoreFocus: () => HTMLElement | null;
    desktop: RefObject<HTMLDivElement | null>;
  };
}) {
  const narrow = useNarrowViewport();
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;
  const applySidebarWidth = (next: number) => {
    const clamped = clampSidebarWidth(next);
    widthRef.current = clamped;
    setSidebarWidth(clamped);
  };
  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add("sidebar-resizing");
    return () => document.body.classList.remove("sidebar-resizing");
  }, [resizing]);
  const startResize = (event: React.PointerEvent<HTMLHRElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = widthRef.current;
    setResizing(true);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      applySidebarWidth(startWidth + next.clientX - startX);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      setResizing(false);
      writeSidebarWidth(widthRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  };
  const resizeWithKeys = (event: React.KeyboardEvent<HTMLHRElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = widthRef.current - SIDEBAR_WIDTH_STEP;
    else if (event.key === "ArrowRight")
      next = widthRef.current + SIDEBAR_WIDTH_STEP;
    else if (event.key === "Home") next = SIDEBAR_WIDTH_MIN;
    else if (event.key === "End") next = SIDEBAR_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    applySidebarWidth(next);
    writeSidebarWidth(widthRef.current);
  };
  const resetSidebarWidth = () => {
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    writeSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  };
  useEffect(() => {
    if (!navigation) return;
    if (!narrow && navigation.trigger.current === document.activeElement)
      navigation.restoreFocus()?.focus();
    if (narrow && navigation.desktop.current?.contains(document.activeElement))
      navigation.trigger.current?.focus();
  }, [narrow, navigation]);
  return (
    <div
      className="relative grid grid-cols-[var(--sidebar-width)_minmax(0,1fr)] h-full bg-app narrow:grid-cols-[minmax(0,1fr)]"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div
        id="sidebar-navigation"
        ref={navigation?.desktop}
        inert={narrow}
        aria-hidden={narrow || undefined}
        className="flex min-h-0 flex-col narrow:hidden"
      >
        {sidebar}
      </div>
      <div className="flex flex-col min-w-0 min-h-0">
        <div className="hidden flex-none items-center gap-2 border-b border-line px-3 py-2 narrow:flex">
          {navigation ? (
            <IconButton
              ref={navigation.trigger}
              label="Open navigation"
              aria-expanded={navigation.open && narrow}
              onClick={() => navigation.onOpenChange(true)}
              touchTarget
            >
              <Menu size={16} />
            </IconButton>
          ) : null}
        </div>
        {children}
      </div>
      {narrow ? null : (
        <hr
          data-sidebar-resize=""
          aria-orientation="vertical"
          aria-label="Resize navigation"
          aria-controls="sidebar-navigation"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={sidebarWidth}
          data-resizing={resizing ? "true" : undefined}
          tabIndex={0}
          className="sidebar-resize"
          onPointerDown={startResize}
          onKeyDown={resizeWithKeys}
          onDoubleClick={resetSidebarWidth}
        />
      )}
      {navigation ? (
        <Modal
          open={navigation.open && narrow}
          onOpenChange={navigation.onOpenChange}
          onClosed={navigation.onClosed}
          restoreFocus={navigation.restoreFocus}
          title="Navigation"
          side="left"
        >
          {sidebar}
        </Modal>
      ) : null}
    </div>
  );
}

export function Sidebar({
  children,
  footer,
  list,
  inert = false,
}: {
  children: ReactNode;
  footer?: ReactNode;
  list?: ReactNode;
  inert?: boolean;
}) {
  return (
    <div
      className="flex flex-1 flex-col min-h-0 border-r border-line bg-app"
      inert={inert}
    >
      {list === undefined ? (
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>
      ) : (
        <>
          <div className="flex-none">{children}</div>
          <div className="flex flex-col flex-1 min-h-0 overflow-y-auto border-t border-line">
            {list}
          </div>
        </>
      )}
      {footer ? (
        <div className="flex-none border-t border-line">{footer}</div>
      ) : null}
    </div>
  );
}

export function SidebarBrand() {
  return (
    <div className="flex items-center gap-3 pt-4 px-4 pb-3 min-w-0">
      <img
        src={brandIcon}
        alt=""
        className="size-6 flex-none -translate-y-0.5"
      />
      <span className="text-lg font-semibold truncate">Fora</span>
    </div>
  );
}

export function Nav({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const container = useRef<HTMLElement>(null);

  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      container.current?.querySelectorAll<HTMLButtonElement>(
        "[data-nav]:not([disabled])",
      ) ?? [],
    ).filter((item) => item.offsetParent !== null);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(index + delta + items.length) % items.length].focus();
  };

  return (
    <nav
      className="flex flex-col p-2"
      aria-label={label}
      ref={container}
      onKeyDown={move}
    >
      <ul className="flex flex-col gap-px min-h-0">{children}</ul>
    </nav>
  );
}

export function NavItem({
  icon,
  label,
  active,
  trailing,
  onSelect,
  children,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  trailing?: ReactNode;
  onSelect: () => void;
  children?: ReactNode;
}) {
  const nested = Children.toArray(children);
  return (
    <li>
      <div
        className={clsx(
          "group relative flex items-center rounded-sm transition-[background-color] duration-(--duration-fast) ease-linear hover:bg-surface-raised before:content-[''] before:absolute before:left-0 before:top-1/2 before:w-[2px] before:rounded-r-[9999px] before:bg-blue-300 before:-translate-y-1/2 before:transition-[height] before:duration-(--duration-base) before:ease-transform",
          active ? "bg-surface-raised before:h-4" : "before:h-0",
        )}
        data-active={active}
      >
        <button
          type="button"
          className={clsx(
            "flex-1 min-w-0 flex items-center gap-2 h-[30px] narrow:min-h-11 touch:min-h-11 py-0 pr-1 pl-4 border-0 rounded-sm bg-transparent text-sm font-medium text-left cursor-pointer transition-[color] duration-(--duration-fast) ease-linear group-hover:text-fg focus-visible:bg-surface-hover focus-visible:text-fg",
            active ? "text-fg" : "text-fg-muted",
          )}
          data-nav="item"
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
        >
          <span
            className={clsx(
              "flex flex-none",
              active ? "text-blue-300" : "text-fg-muted",
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
          <span className="flex-1 min-w-0 truncate">{label}</span>
        </button>
        <span className={trailingSlot}>{trailing}</span>
      </div>
      {nested.length > 0 ? (
        <ul className="flex flex-col gap-px pt-px px-0 pb-1 *:animate-fade-in">
          {nested}
        </ul>
      ) : null}
    </li>
  );
}

export function NavSubItem({
  label,
  active,
  badge,
  onSelect,
}: {
  label: string;
  active: boolean;
  badge?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={clsx(
          "relative flex items-center gap-2 w-full h-[30px] narrow:min-h-11 touch:min-h-11 py-0 pr-1 pl-4 border-0 rounded-sm text-sm text-left cursor-pointer transition-[background-color,color] duration-(--duration-fast) ease-linear hover:bg-surface-raised hover:text-fg data-[unread=true]:font-medium data-[unread=true]:text-fg",
          active
            ? "bg-surface-raised text-fg font-medium"
            : "bg-transparent text-fg-muted",
        )}
        data-nav="subitem"
        aria-current={active ? "page" : undefined}
        data-unread={badge ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="flex-1 min-w-0 truncate">{label}</span>
        <span className={badgeSlot}>{badge}</span>
      </button>
    </li>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-app">
      {children}
    </main>
  );
}

export function PageTransition({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex-1 flex flex-col min-w-0 min-h-0 animate-rise-in"
      key={id}
    >
      {children}
    </div>
  );
}

export type Crumb = { label: string; onSelect: () => void };

export function PageHeader({
  title,
  status,
  actions,
  crumb,
  leading,
  wrap = false,
}: {
  title: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  crumb?: Crumb | Crumb[];
  leading?: ReactNode;
  wrap?: boolean;
}) {
  return (
    <header className="flex flex-col gap-2 pt-6 px-8 pb-4 flex-none max-[940px]:px-6 narrow:px-3 narrow:pt-3 narrow:pb-3">
      {Array.isArray(crumb) ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center flex-wrap gap-2 text-fg-muted text-xs wrap-anywhere">
            {crumb.map((item, index) => (
              <li
                className="flex items-center flex-wrap gap-2 text-fg-muted text-xs wrap-anywhere"
                key={`${index}:${item.label}`}
              >
                {index > 0 ? <span aria-hidden="true">›</span> : null}
                {index === crumb.length - 1 ? (
                  <span aria-current="page">{item.label}</span>
                ) : (
                  <button
                    type="button"
                    className={clsx(crumbClasses, "m-0")}
                    onClick={item.onSelect}
                  >
                    {item.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : crumb ? (
        <button
          type="button"
          className={clsx(crumbClasses, "-ml-1")}
          onClick={crumb.label ? crumb.onSelect : undefined}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {crumb.label}
        </button>
      ) : null}
      <div
        className={clsx(
          "flex items-start gap-4 narrow:flex-wrap",
          wrap && "flex-wrap",
        )}
      >
        {leading}
        <div
          className={clsx(
            "flex-1 min-w-0 max-w-full flex flex-col gap-1",
            wrap && "basis-auto",
          )}
        >
          <h1 className="wrap-anywhere">{title}</h1>
          {status ? (
            <div
              className={clsx(
                "flex items-center gap-2 text-fg-muted",
                wrap && "flex-wrap",
              )}
            >
              {status}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 pt-0.5 narrow:w-full">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-0 px-8 pb-4 flex-none max-[940px]:px-6 narrow:px-3">
      {children}
    </div>
  );
}

export function PageBody({
  children,
  variant = "scroll",
}: {
  children: ReactNode;
  variant?: "scroll" | "flush";
}) {
  return (
    <div
      className={clsx(
        "flex-1 min-w-0 min-h-0 flex flex-col",
        pageBodyVariants[variant],
      )}
    >
      {children}
    </div>
  );
}

export type Column = {
  key: string;
  label: string;
  align?: "start" | "end";
  width?: string;
  hideBelow?: "sm" | "md";
};

export function Table({
  columns,
  children,
  label,
}: {
  columns: Column[];
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className="w-full table-auto [&_td]:p-3 [&_td]:border-b [&_td]:border-line [&_td]:align-middle [&_td[data-align=end]]:text-right max-[1120px]:[&_td[data-hide-below=md]]:hidden max-[940px]:[&_td[data-hide-below=sm]]:hidden [&_tbody_tr]:relative [&_tbody_tr]:transition-[background-color] [&_tbody_tr]:duration-(--duration-fast) [&_tbody_tr]:ease-linear [&_tbody_tr:hover]:bg-surface-raised/70 [&_tbody_tr[data-highlight=true]]:bg-blue-500/7"
        aria-label={label}
      >
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={clsx(
                  "py-2 px-3 border-b border-line text-fg-muted text-xs font-bold leading-4 tracking-caps uppercase whitespace-nowrap",
                  column.align === "end" ? "text-right" : "text-left",
                  column.hideBelow && columnVisibility[column.hideBelow],
                )}
                data-align={column.align ?? "start"}
                data-hide-below={column.hideBelow}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label ? (
                  column.label
                ) : (
                  <span className="sr-only">Actions</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function RowLink({
  primary,
  secondary,
  onSelect,
  expanded,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  onSelect: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex flex-col gap-px min-w-0 p-0 border-0 rounded-xs bg-transparent text-inherit text-left cursor-pointer after:content-[''] after:absolute after:inset-0"
      onClick={onSelect}
      aria-expanded={expanded}
    >
      <span className="font-semibold text-fg truncate transition-[color] duration-(--duration-fast) ease-linear [tr:hover_&]:text-blue-100">
        {primary}
      </span>
      {secondary ? (
        <span className="text-xs text-fg-muted truncate">{secondary}</span>
      ) : null}
    </button>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h2 className="text-sm font-semibold tracking-body">{title}</h2>
        </div>
        {actions ? <div className="flex gap-2 flex-none">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
