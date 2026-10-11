import { LoadingSkeleton, Skeleton } from "@/components/ui/index";

export function ConversationSkeleton({
  label,
  window = false,
}: {
  label: string;
  window?: boolean;
}) {
  return (
    <LoadingSkeleton label={label}>
      {window ? (
        <Skeleton className="h-8 w-full max-w-[220px] rounded-sm border border-line-interactive shadow-button narrow:max-w-full" />
      ) : null}
      {["trigger", "agent", "trigger"].map((side, index) => (
        <div
          key={`${side}-${index}`}
          className={`flex w-full min-w-0 items-end gap-2 mt-4 ${side === "trigger" ? "justify-end" : ""}`}
        >
          {side === "agent" ? (
            <Skeleton className="size-[26px] shrink-0 rounded-sm" />
          ) : null}
          <div className="flex min-w-0 w-[65%] max-w-[85%] flex-col gap-1">
            <Skeleton
              className={`w-24 ${side === "trigger" ? "self-end" : ""}`}
            />
            <div
              className={`flex flex-col gap-2 rounded-lg px-4 py-3 ${side === "trigger" ? "bg-surface-hover" : "border border-line bg-surface-raised"}`}
            >
              <Skeleton className="w-full" />
              <Skeleton className="w-3/4" />
            </div>
          </div>
          {side === "trigger" ? (
            <Skeleton className="size-[26px] shrink-0 rounded-sm" />
          ) : null}
        </div>
      ))}
    </LoadingSkeleton>
  );
}
