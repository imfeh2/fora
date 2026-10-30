import { Button, Skeleton } from "@/components/ui/index";
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

export function ThreadHeader({
  title,
  missing = false,
  onBack,
  actions,
}: {
  title: string | null;
  missing?: boolean;
  onBack?: () => void;
  actions?: MenuAction[];
}) {
  return (
    <header className="flex flex-none items-start gap-2 px-6 pt-5 pb-3 narrow:px-3 narrow:pt-3 narrow:pb-[10px]">
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
      {missing ? (
        <Button onClick={onBack}>Back to Discussions</Button>
      ) : actions ? (
        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            aria-label="Search this discussion"
            className={headerIconClass}
          >
            <SearchIcon />
          </button>
          <OverflowMenu
            label="Discussion actions"
            triggerClassName={headerIconClass}
            icon={<MoreIcon />}
            actions={actions}
          />
        </div>
      ) : null}
    </header>
  );
}
