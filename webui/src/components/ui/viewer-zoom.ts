import { select } from "d3-selection";
import {
  type D3ZoomEvent,
  type ZoomTransform,
  zoom,
  zoomIdentity,
  zoomTransform,
} from "d3-zoom";
import { animate, cancelFrame, frame } from "framer-motion";

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

export function interpolateView(
  start: ZoomTransform,
  target: ZoomTransform,
  progress: number,
): ZoomTransform {
  if (progress === 0) return start;
  if (progress === 1) return target;
  const mix = (from: number, to: number) =>
    from * (1 - progress) + to * progress;
  return zoomIdentity
    .translate(mix(start.x, target.x), mix(start.y, target.y))
    .scale(mix(start.k, target.k));
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
  let rendered = zoomTransform(viewport);
  let animationTarget = rendered;
  let generation = 0;
  let syncing = false;
  let disposed = false;
  let commandDuration: number | null = null;
  let pendingDuration: number | null = null;
  let wheeling = false;
  let wheelDirection = 0;
  let wheelPoint = [0, 0];
  const cancelAnimation = () => {
    generation += 1;
    animation?.stop();
    animation = null;
  };
  const paint = (transform: ZoomTransform) => {
    rendered = transform;
    image.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;
    onScale(transform.k);
  };
  const follow = (target: ZoomTransform, duration: number) => {
    cancelAnimation();
    const start = rendered;
    animationTarget = target;
    if (
      duration === 0 ||
      (start.k === target.k && start.x === target.x && start.y === target.y)
    ) {
      paint(target);
      return;
    }
    const token = generation;
    animation = animate(0, 1, {
      type: "tween",
      duration: duration / 1000,
      ease: "easeOut",
      onUpdate: (progress) => {
        if (!disposed && generation === token)
          paint(interpolateView(start, target, progress));
      },
      onComplete: () => {
        if (!disposed && generation === token) animation = null;
      },
    });
  };
  const followFrame = () => {
    if (!disposed && pendingDuration !== null)
      follow(zoomTransform(viewport), pendingDuration);
    pendingDuration = null;
  };
  const behavior = zoom<HTMLDivElement, unknown>()
    .constrain((transform) =>
      drawableTransform(transform, width, height)
        ? transform
        : zoomTransform(viewport),
    )
    .clickDistance(4)
    .on("zoom.viewer", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
      if (disposed || syncing) return;
      const source = event.sourceEvent as MouseEvent | TouchEvent | undefined;
      const duration =
        commandDuration ??
        (source?.type === "wheel" ||
        (source?.type === "touchmove" &&
          (source as TouchEvent).touches.length > 1)
          ? 135
          : source?.type === "mousemove" || source?.type === "touchmove"
            ? 100
            : 0);
      if (duration === 0) follow(event.transform, 0);
      else {
        if (
          (["x", "y", "k"] as const).some(
            (key) =>
              (event.transform[key] - animationTarget[key]) *
                (animationTarget[key] - rendered[key]) <
              0,
          )
        )
          cancelAnimation();
        pendingDuration = duration;
        frame.postRender(followFrame);
      }
    })
    .on("end.viewer", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
      if (!syncing && event.sourceEvent?.type === "wheel") wheeling = false;
    });
  const stop = () => {
    cancelFrame(followFrame);
    pendingDuration = null;
    cancelAnimation();
    wheeling = false;
    syncing = true;
    selection.call(behavior.transform, rendered);
    syncing = false;
  };
  const wheel = (event: WheelEvent) => {
    if (event.button) return;
    if (!(event.target instanceof Node) || !viewport.contains(event.target)) {
      stop();
      return;
    }
    const direction = Math.sign(event.deltaY);
    if (
      !wheeling ||
      direction !== wheelDirection ||
      event.clientX !== wheelPoint[0] ||
      event.clientY !== wheelPoint[1]
    )
      stop();
    wheeling = true;
    wheelDirection = direction;
    wheelPoint = [event.clientX, event.clientY];
  };
  const down = (event: MouseEvent) => {
    if (!event.button && !event.ctrlKey) stop();
  };
  const touchEnd = (event: TouchEvent) => {
    if (event.touches.length > 0 || event.type === "touchcancel") stop();
  };
  const command = (duration: number, change: () => void) => {
    stop();
    commandDuration = duration;
    change();
    commandDuration = null;
  };
  const fit = (duration = 300) => {
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
      command(duration, () => selection.call(behavior.transform, transform));
  };
  selection.call(behavior).on("dblclick.zoom", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === image) fit();
  });
  viewport.addEventListener("mousedown", down, true);
  viewport.addEventListener("touchstart", stop, {
    capture: true,
    passive: true,
  });
  viewport.addEventListener("touchend", touchEnd, true);
  viewport.addEventListener("touchcancel", touchEnd, true);
  window.addEventListener("wheel", wheel, { capture: true, passive: true });
  fit(0);
  return {
    fit: () => fit(),
    scaleBy: (factor) =>
      command(300, () => selection.call(behavior.scaleBy, factor)),
    stop,
    dispose: () => {
      disposed = true;
      stop();
      selection.on(".zoom", null);
      viewport.removeEventListener("mousedown", down, true);
      viewport.removeEventListener("touchstart", stop, true);
      viewport.removeEventListener("touchend", touchEnd, true);
      viewport.removeEventListener("touchcancel", touchEnd, true);
      window.removeEventListener("wheel", wheel, true);
    },
  };
}
