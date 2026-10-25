import { Download, ImageOff, Minus, Plus, RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Lightbox, { type SlideImage } from "yet-another-react-lightbox";
import { Spinner } from "@/components/ui/index";
import { StatePanel } from "@/components/ui/state-panel";
import { connectBackdropClick } from "./viewer-backdrop";
import { connectImageZoom, type ImageZoom, zoomPercent } from "./viewer-zoom";
import "yet-another-react-lightbox/styles.css";
import "./image-viewer.css";

export type ViewerImage = SlideImage & {
  name?: string;
  load?: (signal: AbortSignal) => Promise<Blob>;
};

type ImageInfo = {
  src: string;
  url: string | null;
  dimensions: { width: number; height: number } | null;
  failed: boolean;
};

type RegisterZoom = (actions: ImageZoom) => () => void;

function ZoomImage({
  slide,
  active,
  register,
  onScale,
  onInfo,
  onRetry,
  onClose,
}: {
  slide: ViewerImage;
  active: boolean;
  register: RegisterZoom;
  onScale: (scale: number) => void;
  onInfo: (info: ImageInfo) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (active && viewport.current)
      return connectBackdropClick(viewport.current, () => close.current());
  }, [active]);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
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
    const unregister = register(actions);
    setVisible(true);
    return () => {
      unregister();
      actions.dispose();
    };
  }, [active, failed, dimensions, register, onScale]);
  return (
    <div ref={viewport} className="viewer-viewport">
      {url && !failed ? (
        <img
          ref={image}
          src={url}
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
          onError={() => setFailed(true)}
        />
      ) : null}
      {failed ? (
        <div className="viewer-feedback">
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
        </div>
      ) : dimensions === null ? (
        <div className="viewer-feedback">
          <Spinner label="Loading image" />
        </div>
      ) : null}
    </div>
  );
}

function ViewerSlide(props: Omit<Parameters<typeof ZoomImage>[0], "onRetry">) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ZoomImage
      {...props}
      key={attempt}
      onRetry={() => setAttempt((value) => value + 1)}
    />
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
  images: ViewerImage[];
  index?: number;
  onClose: () => void;
  onIndex?: (index: number) => void;
}) {
  const actions = useRef<ImageZoom | null>(null);
  const [scale, setScale] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(index);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const current = images[currentIndex];
  const loaded = info?.src === current?.src && !info?.failed ? info : null;
  const dimensions = loaded?.dimensions;
  const ready = dimensions != null;
  const name = current?.name ?? current?.alt ?? "Image";
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
    return () => {
      window.removeEventListener("keydown", keys, true);
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("pointercancel", stop, true);
    };
  }, [open]);
  return (
    <Lightbox
      open={open}
      className="image-viewer"
      close={onClose}
      slides={images}
      index={index}
      controller={{
        aria: true,
        disableSwipeNavigation: true,
        closeOnBackdropClick: false,
      }}
      carousel={{ padding: 0, spacing: 0, preload: images.length > 1 ? 1 : 0 }}
      toolbar={{
        buttons: [
          <a
            key="download"
            className="yarl__button viewer-download"
            href={ready ? (loaded?.url ?? undefined) : undefined}
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
      }}
      on={{
        view: ({ index: next }) => {
          setCurrentIndex(next);
          onIndex?.(next);
        },
        exiting: () => actions.current?.stop(),
      }}
      render={{
        slide: ({ slide, offset }) => (
          <ViewerSlide
            key={slide.src}
            slide={slide}
            active={offset === 0}
            register={register}
            onScale={setScale}
            onInfo={setInfo}
            onClose={onClose}
          />
        ),
        controls: () => (
          <>
            <header className="viewer-heading">
              <div className="viewer-name" title={name}>
                {name}
              </div>
              <div className="viewer-details">
                <span className="viewer-dimensions">
                  {ready ? `${dimensions.width} × ${dimensions.height}` : "—"}
                </span>
                {images.length > 1 ? (
                  <span title="Image number">
                    {currentIndex + 1} / {images.length}
                  </span>
                ) : null}
              </div>
            </header>
            <fieldset className="viewer-zoom-controls" aria-label="Image zoom">
              <button
                type="button"
                aria-label="Zoom out"
                title="Zoom out"
                disabled={!ready}
                onClick={() => actions.current?.scaleBy(1 / 1.25)}
              >
                <Minus size={18} />
              </button>
              <button
                className="viewer-percent"
                type="button"
                aria-label="Fit image"
                title="Fit image"
                disabled={!ready}
                onClick={() => actions.current?.fit()}
              >
                {ready
                  ? zoomPercent(scale)
                  : info?.src === current?.src && info.failed
                    ? "—"
                    : "Loading…"}
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                title="Zoom in"
                disabled={!ready}
                onClick={() => actions.current?.scaleBy(1.25)}
              >
                <Plus size={18} />
              </button>
            </fieldset>
          </>
        ),
        ...(images.length < 2
          ? { buttonPrev: () => null, buttonNext: () => null }
          : {}),
      }}
    />
  );
}
