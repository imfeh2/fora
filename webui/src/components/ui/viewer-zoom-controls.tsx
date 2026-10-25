import { clsx } from "clsx";
import { Minus, Plus } from "lucide-react";
import type { RefObject } from "react";
import { type ImageZoom, zoomPercent } from "./viewer-zoom";

export function ViewerZoomControls({
  actions,
  scale,
  ready,
  failed,
}: {
  actions: RefObject<ImageZoom | null>;
  scale: number;
  ready: boolean;
  failed: boolean;
}) {
  const controls = [
    { label: "Zoom out", factor: 1 / 1.25, content: <Minus size={18} /> },
    {
      label: "Fit image",
      factor: 0,
      content: ready ? zoomPercent(scale) : failed ? "—" : "Loading…",
    },
    { label: "Zoom in", factor: 1.25, content: <Plus size={18} /> },
  ];
  return (
    <fieldset
      className="viewer-zoom-controls absolute left-1/2 bottom-[max(16px,env(safe-area-inset-bottom))] [transform:translateX(-50%)] z-1 flex items-center m-0 p-0.5 border border-line rounded-md bg-surface-raised"
      aria-label="Image zoom"
    >
      {controls.map(({ label, factor, content }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          title={label}
          disabled={!ready}
          className={clsx(
            "inline-flex items-center justify-center min-w-10 h-10 px-2 py-0 border-0 border-none rounded-sm bg-transparent text-inherit text-sm tabular-nums cursor-pointer disabled:text-fg-muted disabled:cursor-default [&:hover:enabled]:bg-surface-hover focus-visible:outline-2 focus-visible:outline-line-focus focus-visible:-outline-offset-2 [@media(max-width:480px)]:min-w-11 [@media(max-width:480px)]:h-11",
            factor === 0 && "viewer-percent min-w-[92px]!",
          )}
          onClick={() =>
            factor ? actions.current?.scaleBy(factor) : actions.current?.fit()
          }
        >
          {content}
        </button>
      ))}
    </fieldset>
  );
}
