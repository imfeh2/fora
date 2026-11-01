import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RouterProvider } from "@/app/router";
import { clearToasts, Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TextDocument } from "@/features/library/document";
import { BackendError, backend } from "@/lib/backend";

function renderDocument() {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <TextDocument path="notes/plan.md" />
        <Toaster />
      </RouterProvider>
    </TooltipProvider>,
  );
}

beforeAll(() => {
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

beforeEach(() => {
  clearToasts();
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

describe("document saving", () => {
  it("reports a refused save as a toast without an inline alert", async () => {
    vi.spyOn(backend, "readLibrary").mockResolvedValue({
      path: "notes/plan.md",
      content: "first line",
      hash: "hash-1",
    });
    vi.spyOn(backend, "writeLibrary").mockRejectedValue(
      new BackendError("storage_write_failed", "The Library is read only"),
    );
    const { container } = renderDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Edit document" }),
    );
    const textarea = await screen.findByLabelText("Document");
    fireEvent.change(textarea, { target: { value: "second line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Could not save the document")).toBeTruthy();
    expect(screen.getByText("The Library is read only")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a load failure in the retry band", async () => {
    vi.spyOn(backend, "readLibrary").mockRejectedValue(
      new BackendError("storage_read_failed", "The Library is unreadable"),
    );
    const { container } = renderDocument();

    expect(await screen.findByText(/The Library is unreadable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
