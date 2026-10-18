import { CircleAlert } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

export type GenerationState =
  | { status: "generating" | "sending" | "sent" }
  | {
      status: "failed" | "interrupted";
      reason: string;
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
      <span
        role="img"
        className="inline-flex size-[18px] items-center justify-center rounded-xs text-danger"
        aria-label={name}
      >
        <CircleAlert size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
