import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageViewer } from "./image-viewer";
import { ViewerViewport } from "./viewer-viewport";
import type { ImageZoom } from "./viewer-zoom";

it("keeps the active controller through strict effects and slide handover", () => {
  const actionsRef: { current: ImageZoom | null } = { current: null };
  const onInfo = vi.fn();
  const onScale = vi.fn();
  const onClose = vi.fn();
  const slides = [
    { src: "first.png", alt: "First image" },
    { src: "next.png", alt: "Next image" },
  ];
  const scene = (active: number) => (
    <StrictMode>
      {slides.map((slide, index) => (
        <ViewerViewport
          key={slide.src}
          slide={slide}
          active={index === active}
          actionsRef={actionsRef}
          onInfo={onInfo}
          onScale={onScale}
          onClose={onClose}
        />
      ))}
    </StrictMode>
  );
  const view = render(scene(0));
  for (const name of ["First image", "Next image"]) {
    const image = screen.getByAltText(name);
    Object.defineProperties(image, {
      naturalWidth: { value: 300 },
      naturalHeight: { value: 200 },
    });
    fireEvent.load(image);
  }
  const first = actionsRef.current;
  expect(first).not.toBeNull();
  expect(
    (screen.getByAltText("Next image") as HTMLImageElement).style.visibility,
  ).toBe("hidden");
  if (!first) throw new Error("Missing first controller");
  const disposeFirst = vi.spyOn(first, "dispose");
  view.rerender(scene(1));
  expect(disposeFirst).toHaveBeenCalledTimes(1);
  expect(actionsRef.current).not.toBe(first);
  expect(
    (screen.getByAltText("First image") as HTMLImageElement).style.visibility,
  ).toBe("visible");
  const next = actionsRef.current;
  if (!next) throw new Error("Missing next controller");
  const disposeNext = vi.spyOn(next, "dispose");
  view.unmount();
  expect(actionsRef.current).toBeNull();
  expect(disposeNext).toHaveBeenCalledTimes(1);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows a loading scale and aborts pending image requests on unmount", async () => {
  const signals: AbortSignal[] = [];
  const load = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<Blob>(() => {});
  });
  const view = render(
    <ImageViewer
      open
      images={[{ src: "pending", name: "pending.png", load }]}
      onClose={() => {}}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalled());
  const fit = screen.getByRole("button", {
    name: "Fit image",
  }) as HTMLButtonElement;
  expect(fit.disabled).toBe(true);
  expect(fit.textContent).toBe("Loading…");
  expect(
    screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled"),
  ).toBe(true);
  view.unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it("retries a failed image request and releases the owned object URL", async () => {
  const created = vi.fn(() => "blob:retried-image");
  const revoked = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = created;
      static revokeObjectURL = revoked;
    },
  );
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue(new Blob(["image"]));
  const view = render(
    <ImageViewer
      open
      images={[{ src: "retry", name: "retry.png", load }]}
      onClose={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Image could not be loaded" });
  expect(screen.getByRole("button", { name: "Fit image" }).textContent).toBe(
    "—",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(created).toHaveBeenCalled());
  expect(load).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(revoked).toHaveBeenCalledWith("blob:retried-image");
});

it("replaces the old percentage with loading while the next image is pending", async () => {
  const images = [
    { src: "ready.png", name: "ready.png", alt: "Ready image" },
    {
      src: "pending",
      name: "pending.png",
      load: () => new Promise<Blob>(() => {}),
    },
  ];
  const view = render(
    <ImageViewer open images={images} index={0} onClose={() => {}} />,
  );
  const image = await screen.findByAltText("Ready image");
  Object.defineProperties(image, {
    naturalWidth: { value: 300 },
    naturalHeight: { value: 200 },
  });
  fireEvent.load(image);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Fit image" }).textContent).toBe(
      "100%",
    ),
  );
  view.rerender(
    <ImageViewer open images={images} index={1} onClose={() => {}} />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Fit image" }).textContent).toBe(
      "Loading…",
    ),
  );
  expect(
    screen.getByRole("button", { name: "Fit image" }).hasAttribute("disabled"),
  ).toBe(true);
});
