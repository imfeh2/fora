import { ImageOff, RotateCw } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SlideImage } from "yet-another-react-lightbox";
import { Spinner } from "@/components/ui/index";
import { StatePanel } from "@/components/ui/state-panel";
import { connectImageZoom, type ImageZoom } from "./viewer-zoom";

export type ViewerImage = SlideImage & {
  name?: string;
  load?: (signal: AbortSignal) => Promise<Blob>;
};
export type ImageInfo = {
  src: string;
  url: string | null;
  dimensions: { width: number; height: number } | null;
  failed: boolean;
};
type ViewportProps = {
  slide: ViewerImage;
  active: boolean;
  actionsRef: RefObject<ImageZoom | null>;
  onScale: (scale: number) => void;
  onInfo: (info: ImageInfo) => void;
  onClose: () => void;
};

export function connectBackdropClick(viewport: HTMLElement, close: () => void) {
  const listeners = new AbortController();
  const capture = { capture: true, signal: listeners.signal };
  const pointers = new Set<number>();
  let press: { id: number; x: number; y: number } | null = null;
  let touchClick = false;
  const move = (event: PointerEvent) => {
    if (
      press?.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 5
    )
      press = null;
  };
  const cancel = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    press = null;
    touchClick = false;
  };
  const down = (event: PointerEvent) => {
    pointers.add(event.pointerId);
    press =
      pointers.size === 1 && event.button === 0 && event.target === viewport
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
  };
  const up = (event: PointerEvent) => {
    move(event);
    const clicked = press?.id === event.pointerId;
    pointers.delete(event.pointerId);
    press = null;
    if (clicked) {
      if (event.pointerType === "touch") touchClick = true;
      else close();
    }
  };
  const clear = () => {
    pointers.clear();
    press = null;
    touchClick = false;
  };
  const touchEnd = (event: TouchEvent) => {
    if (!touchClick) return;
    touchClick = false;
    event.preventDefault();
    close();
  };
  window.addEventListener("pointerdown", down, capture);
  window.addEventListener("pointermove", move, capture);
  window.addEventListener("pointerup", up, capture);
  window.addEventListener("pointercancel", cancel, capture);
  window.addEventListener("blur", clear, { signal: listeners.signal });
  window.addEventListener("touchend", touchEnd, { ...capture, passive: false });
  return () => listeners.abort();
}

function ZoomImage({
  slide,
  active,
  actionsRef,
  onScale,
  onInfo,
  onClose,
  onRetry,
}: ViewportProps & { onRetry: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (active && viewport.current)
      return connectBackdropClick(viewport.current, () => close.current());
  }, [active]);
  const [dimensions, setDimensions] = useState<ImageInfo["dimensions"]>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState(slide.load ? null : slide.src);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!slide.load) return;
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null);
    setDimensions(null);
    setVisible(false);
    setFailed(false);
    void slide.load(abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => {
        if (!abort.signal.aborted) setFailed(true);
      },
    );
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [slide.load]);
  useLayoutEffect(() => {
    if (active) onInfo({ src: slide.src, url, dimensions, failed });
  }, [active, slide.src, url, dimensions, failed, onInfo]);
  useLayoutEffect(() => {
    if (
      !active ||
      failed ||
      dimensions === null ||
      !viewport.current ||
      !image.current
    )
      return;
    const actions = connectImageZoom(viewport.current, image.current, onScale);
    actionsRef.current = actions;
    setVisible(true);
    return () => {
      if (actionsRef.current === actions) actionsRef.current = null;
      actions.dispose();
    };
  }, [active, failed, dimensions, actionsRef, onScale]);
  return (
    <div
      ref={viewport}
      className="viewer-viewport absolute inset-0 overflow-hidden touch-none cursor-grab active:cursor-grabbing"
    >
      {url && !failed && (
        <img
          ref={image}
          src={url}
          alt={slide.alt ?? ""}
          draggable={false}
          className="viewer-image absolute top-0 left-0 max-w-none max-h-none origin-top-left select-none"
          style={{
            width: dimensions?.width,
            height: dimensions?.height,
            visibility: visible ? "visible" : "hidden",
          }}
          onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } =
              event.currentTarget;
            setDimensions({ width, height });
          }}
          onError={() => setFailed(true)}
        />
      )}
      {(failed || dimensions === null) && (
        <div className="viewer-feedback pointer-events-none absolute inset-x-12 inset-y-20 flex items-center justify-center [&_.state-panel]:pointer-events-auto">
          {failed ? (
            <StatePanel
              compact
              icons={[ImageOff, ImageOff, ImageOff]}
              title="Image could not be loaded"
              action={{
                label: "Retry",
                icon: <RotateCw size={16} />,
                onClick: onRetry,
              }}
            />
          ) : (
            <Spinner label="Loading image" />
          )}
        </div>
      )}
    </div>
  );
}

export function ViewerViewport(props: ViewportProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ZoomImage
      {...props}
      key={attempt}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
