import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Lightbox, { type SlideImage } from "yet-another-react-lightbox";
import { connectImageZoom, type ImageZoom, zoomPercent } from "./viewer-zoom";
import "yet-another-react-lightbox/styles.css";
import "./image-viewer.css";

type RegisterZoom = (actions: ImageZoom) => () => void;

function ZoomImage({
  slide,
  active,
  register,
  onScale,
}: {
  slide: SlideImage;
  active: boolean;
  register: RegisterZoom;
  onScale: (scale: number) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    if (!active || dimensions === null || !viewport.current || !image.current)
      return;
    const actions = connectImageZoom(viewport.current, image.current, onScale);
    const unregister = register(actions);
    setVisible(true);
    return () => {
      unregister();
      actions.dispose();
    };
  }, [active, dimensions, register, onScale]);
  return (
    <div ref={viewport} className="viewer-viewport">
      <img
        ref={image}
        src={slide.src}
        alt={slide.alt ?? ""}
        draggable={false}
        className="viewer-image"
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
      />
    </div>
  );
}

export function ImageViewer({
  open,
  images,
  index = 0,
  onClose,
  onIndex,
}: {
  open: boolean;
  images: SlideImage[];
  index?: number;
  onClose: () => void;
  onIndex?: (index: number) => void;
}) {
  const actions = useRef<ImageZoom | null>(null);
  const [scale, setScale] = useState(1);
  const register = useCallback<RegisterZoom>((value) => {
    actions.current = value;
    return () => {
      if (actions.current === value) actions.current = null;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const keys = (event: KeyboardEvent) => {
      const current = actions.current;
      if (!current || !["+", "=", "-", "0"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "0") current.fit();
      else current.scaleBy(event.key === "-" ? 1 / 1.25 : 1.25);
    };
    const stop = () => actions.current?.stop();
    window.addEventListener("keydown", keys, true);
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("pointercancel", stop, true);
    window.addEventListener("wheel", stop, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", keys, true);
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("wheel", stop, true);
    };
  }, [open]);
  return (
    <Lightbox
      open={open}
      close={onClose}
      slides={images}
      index={index}
      controller={{ disableSwipeNavigation: true, closeOnBackdropClick: false }}
      carousel={{ padding: 0, spacing: 0 }}
      on={{
        view: ({ index: next }) => onIndex?.(next),
        exiting: () => actions.current?.stop(),
      }}
      render={{
        slide: ({ slide, offset }) => (
          <ZoomImage
            key={slide.src}
            slide={slide}
            active={offset === 0}
            register={register}
            onScale={setScale}
          />
        ),
        controls: () => (
          <button
            className="viewer-percent"
            type="button"
            aria-label="Fit image"
            onClick={() => actions.current?.fit()}
          >
            {zoomPercent(scale)}
          </button>
        ),
      }}
    />
  );
}
