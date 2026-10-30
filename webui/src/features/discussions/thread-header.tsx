import { clsx } from "clsx";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Ref } from "react";
import { Button, IconButton, Input, Skeleton } from "@/components/ui/index";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";

const headerIconClass =
  "inline-flex size-7 flex-none items-center justify-center rounded-sm border-0 bg-transparent p-0 text-fg-muted cursor-pointer transition-[background-color,color] duration-[120ms] ease-linear hover:bg-surface-hover hover:text-fg focus-visible:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 touch:size-11 touch:min-w-11 touch:min-h-11";

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.75" />
      <path d="M10.6 10.6 14 14" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

export type ThreadSearchControls = {
  open: boolean;
  query: string;
  count: number;
  position: number;
  inputRef: Ref<HTMLInputElement>;
  buttonRef: Ref<HTMLButtonElement>;
  onToggle: () => void;
  onChange: (value: string, composing: boolean) => void;
  onCommit: (value: string) => void;
  onStep: (delta: number) => void;
};

export function ThreadHeader({
  title,
  missing = false,
  onBack,
  menu,
  search,
}: {
  title: string | null;
  missing?: boolean;
  onBack?: () => void;
  menu?: MenuAction[];
  search?: ThreadSearchControls;
}) {
  return (
    <header className="flex flex-none items-start gap-2 px-6 pt-5 pb-3 narrow:flex-wrap narrow:px-3 narrow:pt-3 narrow:pb-[10px]">
      {title === null ? (
        <Skeleton className="h-7 w-44 max-w-full" />
      ) : (
        <h1
          className="min-h-7 min-w-0 flex-1 line-clamp-2 text-[20px] font-semibold leading-[26px] tracking-[-0.02em] wrap-anywhere"
          title={title}
        >
          {title}
        </h1>
      )}
      {search?.open ? (
        <div className="flex min-w-0 items-center gap-2 narrow:order-last narrow:basis-full">
          <Input
            ref={search.inputRef}
            type="search"
            value={search.query}
            placeholder="在这条讨论里搜"
            aria-label="Search this discussion"
            className="w-[320px]! max-w-full shrink-0 focus:border-blue-300! focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-blue-300)_18%,transparent)]! narrow:w-auto! narrow:max-w-none narrow:min-w-0 narrow:flex-1"
            onChange={(event) =>
              search.onChange(
                event.currentTarget.value,
                (event.nativeEvent as InputEvent).isComposing,
              )
            }
            onCompositionEnd={(event) =>
              search.onCommit(event.currentTarget.value)
            }
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key !== "Enter") return;
              event.preventDefault();
              search.onStep(event.shiftKey ? -1 : 1);
            }}
          />
          <span
            aria-live="polite"
            className="flex-none text-xs leading-4 text-fg-muted"
          >
            {search.count > 0
              ? `第 ${search.position + 1} / ${search.count} 条`
              : "没有匹配"}
          </span>
          <IconButton
            label="Previous match"
            size="sm"
            className="size-7!"
            disabled={search.count === 0}
            onClick={() => search.onStep(-1)}
          >
            <ChevronUp size={14} />
          </IconButton>
          <IconButton
            label="Next match"
            size="sm"
            className="size-7!"
            disabled={search.count === 0}
            onClick={() => search.onStep(1)}
          >
            <ChevronDown size={14} />
          </IconButton>
        </div>
      ) : null}
      {missing ? (
        <Button onClick={onBack}>Back to Discussions</Button>
      ) : menu && search ? (
        <div className="flex flex-none items-center gap-1">
          <button
            ref={search.buttonRef}
            type="button"
            aria-label="Search this discussion"
            aria-expanded={search.open}
            onClick={search.onToggle}
            className={clsx(
              headerIconClass,
              search.open && "bg-surface-pressed text-fg",
            )}
          >
            <SearchIcon />
          </button>
          <OverflowMenu
            label="Discussion actions"
            triggerClassName={headerIconClass}
            icon={<MoreIcon />}
            actions={menu}
          />
        </div>
      ) : null}
    </header>
  );
}
