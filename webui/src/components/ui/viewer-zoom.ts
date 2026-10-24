import { select } from "d3-selection";
import {
  type D3ZoomEvent,
  type ZoomTransform,
  zoom,
  zoomIdentity,
  zoomTransform,
} from "d3-zoom";
import { animate } from "framer-motion";

const percentFormat = new Intl.NumberFormat("en", {
  maximumSignificantDigits: 3,
  useGrouping: false,
});

export function zoomPercent(scale: number): string {
  const percent = scale * 100;
  return `${percent < 0.001 || percent >= 1e6 ? percent.toExponential(2) : percentFormat.format(percent)}%`;
}

export function drawableTransform(
  transform: Pick<ZoomTransform, "k" | "x" | "y">,
  width: number,
  height: number,
): boolean {
  const { k, x, y } = transform;
  return (
    k > 0 &&
    Math.fround(k) > 0 &&
    [k, x, y, x + width * k, y + height * k, 1 / k].every(
      (value) => Number.isFinite(value) && Number.isFinite(Math.fround(value)),
    )
  );
}

type MotionSample = { x: number; y: number; time: number };

export function releaseVelocity(
  samples: MotionSample[],
  time: number,
): { x: number; y: number } {
  const recent = samples.filter((sample) => time - sample.time <= 80);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (recent.length < 2 || time <= first.time) return { x: 0, y: 0 };
  const elapsed = time - first.time;
  return {
    x: ((last.x - first.x) / elapsed) * 1000,
    y: ((last.y - first.y) / elapsed) * 1000,
  };
}

export type ImageZoom = {
  fit: () => void;
  scaleBy: (factor: number) => void;
  stop: () => void;
  dispose: () => void;
};

export function connectImageZoom(
  viewport: HTMLDivElement,
  image: HTMLImageElement,
  onScale: (scale: number) => void,
): ImageZoom {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const selection = select(viewport);
  let animation: ReturnType<typeof animate> | null = null;
  let samples: MotionSample[] = [];
  let disposed = false;
  const stop = () => {
    animation?.stop();
    animation = null;
    samples = [];
  };
  const behavior = zoom<HTMLDivElement, unknown>()
    .constrain((transform) =>
      drawableTransform(transform, width, height)
        ? transform
        : zoomTransform(viewport),
    )
    .clickDistance(4)
    .on("start.viewer", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
      if (disposed || !event.sourceEvent) return;
      stop();
      samples = [
        {
          x: event.transform.x,
          y: event.transform.y,
          time: event.sourceEvent.timeStamp,
        },
      ];
    })
    .on("zoom.viewer", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
      if (disposed) return;
      const { k, x, y } = event.transform;
      image.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      onScale(k);
      const source = event.sourceEvent as MouseEvent | TouchEvent | undefined;
      if (!source) return;
      const single =
        source.type === "mousemove" ||
        (source.type === "touchmove" &&
          (source as TouchEvent).touches.length === 1);
      if (!single) {
        samples = [];
        return;
      }
      const time = source.timeStamp;
      samples = [
        ...samples.filter((sample) => time - sample.time <= 80),
        { x, y, time },
      ];
    })
    .on("end.viewer", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
      const source = event.sourceEvent as Event | undefined;
      if (disposed || !source || !["mouseup", "touchend"].includes(source.type))
        return;
      const velocity = releaseVelocity(samples, source.timeStamp);
      const speed = Math.hypot(velocity.x, velocity.y);
      if (speed === 0) return;
      const direction = { x: velocity.x / speed, y: velocity.y / speed };
      let previous = 0;
      animation = animate(0, speed * 0.25, {
        type: "inertia",
        velocity: speed,
        power: 0.25,
        timeConstant: 250,
        restDelta: 0.25,
        onUpdate: (distance) => {
          const current = zoomTransform(viewport);
          const delta = (distance - previous) / current.k;
          previous = distance;
          const next = current.translate(
            delta * direction.x,
            delta * direction.y,
          );
          if (drawableTransform(next, width, height))
            selection.call(behavior.transform, next);
        },
        onComplete: () => {
          animation = null;
        },
      });
    });
  const fit = () => {
    stop();
    const k = Math.min(
      viewport.clientWidth / width,
      viewport.clientHeight / height,
    );
    const transform = zoomIdentity
      .translate(
        (viewport.clientWidth - width * k) / 2,
        (viewport.clientHeight - height * k) / 2,
      )
      .scale(k);
    if (drawableTransform(transform, width, height))
      selection.call(behavior.transform, transform);
  };
  selection.call(behavior).on("dblclick.zoom", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === image) fit();
  });
  fit();
  return {
    fit,
    scaleBy: (factor) => {
      stop();
      selection.call(behavior.scaleBy, factor);
    },
    stop,
    dispose: () => {
      disposed = true;
      stop();
      selection.on(".zoom", null);
    },
  };
}
