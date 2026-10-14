import { CircleAlert } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

export type GenerationState =
  | { status: "generating" | "sending" | "sent" }
  | {
      status: "failed" | "interrupted";
      reason: string;
      onOpenDetails: () => void;
    };

export function GenerationIndicator({ state }: { state: GenerationState }) {
  if (state.status === "sent") return null;
  if (!("reason" in state))
    return (
      <span
        aria-label="Generating"
        role="status"
        className="inline-block size-[6px] rounded-full bg-primary animate-breathe motion-reduce:animate-none"
      />
    );
  const name = `${state.status === "failed" ? "Not sent" : "Interrupted"}: ${state.reason}`;
  return (
    <Tooltip label={state.reason}>
      <button
        type="button"
        className="inline-flex size-[18px] items-center justify-center rounded-xs text-danger hover:bg-red-500/10 cursor-pointer"
        aria-label={name}
        aria-haspopup="dialog"
        onClick={state.onOpenDetails}
      >
        <CircleAlert size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
