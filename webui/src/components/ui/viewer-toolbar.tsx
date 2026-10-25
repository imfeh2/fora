import { Download } from "lucide-react";
import type { ToolbarSettings } from "yet-another-react-lightbox";
import type { ImageInfo } from "./viewer-viewport";

type ToolbarProps = {
  name: string;
  info: ImageInfo | null;
  index: number;
  total: number;
};

export function viewerToolbar(
  name: string,
  info: ImageInfo | null,
): ToolbarSettings {
  const ready = info?.dimensions != null;
  return {
    buttons: [
      <a
        key="download"
        className="yarl__button viewer-download inline-flex items-center justify-center aria-disabled:opacity-40 aria-disabled:pointer-events-none"
        href={ready ? (info.url ?? undefined) : undefined}
        download={name}
        aria-label="Download image"
        aria-disabled={!ready}
        tabIndex={ready ? 0 : -1}
        title="Download image"
      >
        <Download size={22} />
      </a>,
      "close",
    ],
  };
}

export function ViewerHeading({ name, info, index, total }: ToolbarProps) {
  const dimensions = info?.dimensions;
  return (
    <header className="viewer-heading absolute inset-x-0 top-0 z-1 pt-4 pr-[116px] pb-3 pl-5 bg-[color-mix(in_srgb,var(--color-app)_65%,transparent)] pointer-events-none [@media(max-width:480px)]:pl-3 [@media(max-width:480px)]:pr-[108px]">
      <div
        className="viewer-name w-fit max-w-full pointer-events-auto truncate text-sm font-medium"
        title={name}
      >
        {name}
      </div>
      <div className="viewer-details flex gap-5 mt-1 text-fg-muted text-xs tabular-nums">
        <span className="viewer-dimensions">
          {dimensions ? `${dimensions.width} × ${dimensions.height}` : "—"}
        </span>
        {total > 1 && (
          <span title="Image number">
            {index + 1} / {total}
          </span>
        )}
      </div>
    </header>
  );
}
