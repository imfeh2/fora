import { clsx } from "clsx";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
} from "react";
import { twMerge } from "tailwind-merge";
import { Tooltip } from "@/components/ui/tooltip";

export {
  dismissToast,
  Toaster,
  type ToastOptions,
  type ToastTone,
  toast,
} from "@/components/ui/toast";

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={twMerge(
        "block h-3.5 rounded-xs bg-surface-hover animate-breathe motion-reduce:animate-none motion-reduce:opacity-65",
        className,
      )}
      style={style}
    />
  );
}

export function LoadingSkeleton({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-busy="true" aria-label={label} className="min-w-0">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div aria-hidden="true" className="flex min-w-0 flex-col gap-4">
        {children}
      </div>
    </section>
  );
}

export function FieldSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Skeleton className="w-32 max-w-full" />
      <Skeleton className="h-8 w-full rounded-sm" />
    </div>
  );
}

const buttonVariants = {
  default:
    "border-line-interactive bg-transparent text-fg shadow-button hover:enabled:bg-surface-hover hover:enabled:border-line-hover active:enabled:bg-gray-600 disabled:text-fg-disabled",
  primary:
    "border-blue-500 bg-blue-500 text-gray-0 shadow-button hover:enabled:bg-blue-300 hover:enabled:border-blue-300 active:enabled:bg-blue-700 active:enabled:border-blue-700 disabled:bg-blue-700/45 disabled:border-transparent disabled:text-gray-0/55",
  ghost:
    "border-transparent bg-transparent text-fg-muted shadow-none hover:enabled:bg-surface-hover hover:enabled:text-fg active:enabled:bg-gray-600",
  danger:
    "border-line-interactive bg-transparent text-danger shadow-button hover:enabled:bg-red-500/18 hover:enabled:border-red-500 hover:enabled:text-red-100 active:enabled:not-hover:bg-gray-600",
};

const buttonSizes = {
  md: "h-8 px-3 gap-2 text-sm",
  sm: "h-[26px] px-2 gap-1 text-xs",
};

const iconButtonSizes = {
  md: "size-8 border-line-interactive shadow-button aria-pressed:border-blue-500/50",
  sm: "size-[26px] border-transparent shadow-none",
};

const inputClasses =
  "w-full border border-line-interactive rounded-sm bg-app text-fg text-sm shadow-button transition-[border-color,box-shadow] duration-(--duration-fast) ease-linear hover:enabled:not-focus:border-line-hover placeholder:text-fg-muted focus:border-line-focus focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-ring)_40%,transparent)] [&::-webkit-search-cancel-button]:appearance-none [&[type=number]]:[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0";

const badgeTones = {
  default: "bg-surface-raised text-fg-muted",
  unread:
    "bg-blue-500 text-gray-0 animate-pop-in [animation-duration:var(--duration-base)]",
  pending: "bg-yellow-300 text-gray-1100",
};

const chipTones = {
  neutral: "border-line bg-gray-800 text-fg-muted",
  blue: "border-blue-500/50 bg-blue-500/18 text-blue-100",
  warning: "border-yellow-300/50 bg-yellow-300/16 text-yellow-200",
  danger: "border-red-500/60 bg-red-500/18 text-red-100",
  success: "border-green-500/70 bg-green-500/22 text-green-200",
};

const stateDotStates = {
  idle: "bg-gray-500",
  running: "bg-green-200 animate-breathe",
  paused: "bg-yellow-300",
  blocked: "bg-yellow-300",
  error: "bg-red-300",
};

const dotTones = {
  grey: "bg-gray-500",
  blue: "bg-blue-300",
  green: "bg-green-200",
  yellow: "bg-yellow-300",
  red: "bg-red-300",
};

const avatarClasses =
  "inline-flex items-center justify-center flex-none font-semibold tracking-[0] select-none";

const avatarSizes = {
  xs: "size-[18px] rounded-xs text-[9px]",
  sm: "size-[22px] rounded-sm text-[10px]",
  md: "size-[26px] rounded-sm text-xs",
  lg: "size-10 rounded-md text-sm",
};

const meterTones = {
  normal: "bg-blue-300",
  warning: "bg-yellow-200",
  danger: "bg-red-300",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
  touchTarget?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = "default",
  size = "md",
  type = "button",
  className,
  touchTarget = false,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={clsx(
        "inline-flex items-center justify-center py-0 border rounded-sm font-medium leading-body whitespace-nowrap cursor-pointer transition-[background-color,border-color,color,box-shadow] duration-(--duration-fast) ease-linear disabled:cursor-not-allowed disabled:shadow-none [&_svg]:flex-none",
        buttonVariants[variant],
        buttonSizes[size],
        touchTarget && "narrow:min-h-11 narrow:px-4 touch:min-h-11 touch:px-4",
        className,
      )}
    />
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: "md" | "sm";
  pressed?: boolean;
  touchTarget?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function IconButton({
  label,
  size = "md",
  pressed,
  type = "button",
  className,
  touchTarget = false,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label}>
      <button
        {...rest}
        type={type}
        className={clsx(
          "inline-flex items-center justify-center flex-none border rounded-sm bg-transparent text-fg-muted cursor-pointer transition-[background-color,border-color] duration-(--duration-fast) ease-linear hover:enabled:bg-surface-hover hover:enabled:border-line-hover disabled:not-aria-pressed:text-fg-disabled disabled:cursor-not-allowed aria-pressed:bg-blue-500/18 aria-pressed:text-blue-100",
          iconButtonSizes[size],
          touchTarget &&
            "narrow:size-11 narrow:min-w-11 narrow:min-h-11 touch:size-11 touch:min-w-11 touch:min-h-11",
          className,
        )}
        aria-label={label}
        aria-pressed={pressed}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function Input({
  type,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      {...rest}
      type={type}
      className={
        type === "checkbox"
          ? "appearance-none inline-grid place-content-center size-[14px] flex-none m-0 border border-line-interactive rounded-xs bg-app cursor-pointer checked:border-line-focus checked:bg-line-focus checked:after:content-[''] checked:after:w-1 checked:after:h-2 checked:after:border-fg checked:after:border-r-2 checked:after:border-b-2 checked:after:[transform:translateY(-1px)_rotate(45deg)] disabled:opacity-50 disabled:cursor-not-allowed"
          : clsx(inputClasses, "h-8 px-3 py-0")
      }
    />
  );
}

export function autoGrowHeight(
  scrollHeight: number,
  lineHeight: number,
  padding: number,
  border: number,
  maxRows?: number,
): number {
  const ceiling =
    maxRows && maxRows > 0 ? maxRows * lineHeight + padding : Infinity;
  return Math.min(scrollHeight, ceiling) + border;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export function Textarea({
  ref,
  autoGrow = false,
  maxRows,
  variant = "default",
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
  ref?: Ref<HTMLTextAreaElement>;
  autoGrow?: boolean;
  maxRows?: number;
  variant?: "default" | "composer";
}) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const element = inner.current;
    if (!autoGrow || !element) return;
    const style = getComputedStyle(element);
    const padding =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    const border =
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    element.style.height = "auto";
    element.style.height = `${autoGrowHeight(
      element.scrollHeight,
      Number.parseFloat(style.lineHeight),
      padding,
      border,
      maxRows,
    )}px`;
  });

  return (
    <textarea
      {...rest}
      ref={(element) => {
        inner.current = element;
        assignRef(ref, element);
      }}
      className={clsx(
        variant === "composer"
          ? "block w-full min-h-0 resize-none border-0 bg-transparent pl-4 pr-12 py-3 text-sm leading-[22px] text-(--composer-foreground) placeholder:font-medium placeholder:text-(--composer-muted-foreground)/80 cursor-text outline-none overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-sm hover:[&::-webkit-scrollbar-thumb]:bg-(--composer-muted-foreground)/30"
          : clsx(
              inputClasses,
              "h-auto resize-none py-2 px-3 leading-body",
              autoGrow ? "min-h-0 overflow-y-auto" : "min-h-18",
            ),
      )}
    />
  );
}

export function SearchField({
  icon,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  icon: ReactNode;
}) {
  return (
    <div className="relative flex flex-1 min-w-40 [&>input:not([type=checkbox])]:pl-[34px]">
      <span
        className="absolute left-3 top-1/2 -translate-y-1/2 flex text-fg-muted pointer-events-none"
        aria-hidden="true"
      >
        {icon}
      </span>
      <Input type="search" {...rest} />
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {htmlFor === undefined ? (
        <span className="text-xs font-medium text-fg-muted">{label}</span>
      ) : (
        <label className="text-xs font-medium text-fg-muted" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}

export function Badge({
  tone = "default",
  children,
}: {
  tone?: "default" | "unread" | "pending";
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center gap-1 py-0 px-[6px] min-w-5 h-5 rounded-full text-xs font-medium tabular-nums tracking-[0] whitespace-nowrap",
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "blue" | "warning" | "danger" | "success";
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-[5px] h-5 py-0 px-2 border rounded-xs text-xs font-medium leading-none whitespace-nowrap",
        chipTones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function CountPill({ children }: { children: ReactNode }) {
  return (
    <p className="self-start py-[3px] px-3 rounded-full bg-gray-800 text-fg-muted text-xs font-medium tabular-nums">
      {children}
    </p>
  );
}

export function StateDot({
  state,
  ping = false,
}: {
  state: keyof typeof stateDotStates;
  ping?: boolean;
}) {
  const label = state.charAt(0).toUpperCase() + state.slice(1);
  return (
    <span className="relative inline-flex flex-none items-center justify-center size-2">
      <span
        className={clsx("size-2 rounded-full", stateDotStates[state])}
        data-state={state}
        role="img"
        aria-label={label}
      />
      {ping && state === "running" ? (
        <span
          className="absolute inset-0 rounded-full bg-green-200/55 animate-ping"
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

export function Dot({
  tone,
}: {
  tone: "grey" | "blue" | "green" | "yellow" | "red";
}) {
  return <span className={clsx("size-2 rounded-full", dotTones[tone])} />;
}

export function StatusText({
  dot,
  children,
}: {
  dot: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {dot}
      {children}
    </span>
  );
}

const HUES = [
  "var(--color-blue-100)",
  "var(--color-green-200)",
  "var(--color-yellow-200)",
  "var(--color-red-100)",
  "var(--color-purple-300)",
];

export function identiconFor(memberId: number) {
  let hash = 2166136261;
  for (const character of String(memberId)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash = (hash ^ (hash >>> 16)) >>> 0;

  const cells: { x: number; y: number }[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if ((hash >>> (row * 3 + column)) & 1) {
        cells.push({ x: column + 1, y: row + 1 });
        if (column < 2) cells.push({ x: 5 - column, y: row + 1 });
      }
    }
  }
  return { cells, color: HUES[(hash >>> 15) % HUES.length] };
}

type AvatarSize = "xs" | "sm" | "md" | "lg";

export function Avatar({
  memberId,
  size = "md",
}: {
  memberId: number;
  size?: AvatarSize;
}) {
  const { cells, color } = identiconFor(memberId);
  return (
    <span
      className={clsx(avatarClasses, avatarSizes[size], "bg-surface")}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 7 7"
        className="size-full"
        fill={color}
        aria-hidden="true"
        focusable="false"
      >
        {cells.map(({ x, y }) => (
          <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} />
        ))}
      </svg>
    </span>
  );
}

export function AvatarStack({
  members,
  max = 5,
  size = "sm",
}: {
  members: { id: number; name: string }[];
  max?: number;
  size?: AvatarSize;
}) {
  const shown = members.length > max ? members.slice(0, max) : members;
  const hidden = members.length - shown.length;
  return (
    <span
      className="inline-flex items-center [&>span]:shadow-[0_0_0_2px_var(--color-surface)] [&>span+span]:-ml-[6px]"
      role="img"
      aria-label={members.map((member) => member.name).join(", ")}
    >
      {shown.map((member) => (
        <Avatar key={member.id} memberId={member.id} size={size} />
      ))}
      {hidden > 0 ? (
        <span
          className={clsx(
            avatarClasses,
            avatarSizes[size],
            "bg-gray-700 text-fg-muted",
          )}
          aria-hidden="true"
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

export function Meter({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const tone = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "normal";
  return (
    <div className="w-full h-1 rounded-full bg-gray-700 overflow-hidden">
      <meter
        className="absolute size-px opacity-0 pointer-events-none"
        aria-label={label}
        value={value}
        min={0}
        max={max}
      />
      <span
        className={clsx(
          "block h-full rounded-full transition-[width] duration-(--duration-slow) ease-standard",
          meterTones[tone],
        )}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span
      className="inline-block size-4 flex-none border-2 border-gray-600 border-t-blue-300 rounded-full animate-spin"
      role="status"
      aria-label={label}
    />
  );
}

export function EmptyState({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 px-6 text-fg-muted text-center [&_h3]:text-fg">
      <h3>{title}</h3>
      {action}
    </div>
  );
}
