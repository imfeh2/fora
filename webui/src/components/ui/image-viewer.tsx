import { useCallback, useEffect, useRef, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import { ViewerHeading, viewerToolbar } from "./viewer-toolbar";
import {
  type ImageInfo,
  type ViewerImage,
  ViewerViewport,
} from "./viewer-viewport";
import type { ImageZoom } from "./viewer-zoom";
import { ViewerZoomControls } from "./viewer-zoom-controls";
import "yet-another-react-lightbox/styles.css";
import "./image-viewer.css";

export type { ViewerImage } from "./viewer-viewport";

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
  const ready = loaded?.dimensions != null;
  const name = current?.name ?? current?.alt ?? "Image";
  const register = useCallback((value: ImageZoom) => {
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
      className="image-viewer text-fg font-sans"
      close={onClose}
      slides={images}
      index={index}
      controller={{
        aria: true,
        disableSwipeNavigation: true,
        closeOnBackdropClick: false,
      }}
      carousel={{ padding: 0, spacing: 0, preload: images.length > 1 ? 1 : 0 }}
      toolbar={viewerToolbar(name, loaded)}
      on={{
        view: ({ index: next }) => {
          setCurrentIndex(next);
          onIndex?.(next);
        },
        exiting: () => actions.current?.stop(),
      }}
      render={{
        slide: ({ slide, offset }) => (
          <ViewerViewport
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
            <ViewerHeading
              name={name}
              info={loaded}
              index={currentIndex}
              total={images.length}
            />
            <ViewerZoomControls
              actions={actions}
              scale={scale}
              ready={ready}
              failed={info?.src === current?.src && info?.failed === true}
            />
          </>
        ),
        ...(images.length < 2
          ? { buttonPrev: () => null, buttonNext: () => null }
          : {}),
      }}
    />
  );
}
