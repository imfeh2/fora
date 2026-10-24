import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageViewer } from "./image-viewer";

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
