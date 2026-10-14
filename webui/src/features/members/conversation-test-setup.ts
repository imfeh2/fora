import { afterAll, vi } from "vitest";

vi.stubGlobal(
  "IntersectionObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
afterAll(() => vi.unstubAllGlobals());
