import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BackendEvent, LibraryDocument } from "@/lib/backend";

let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let DocumentPage: typeof import("@/features/library/document").DocumentPage;
let RouterProvider: typeof import("@/app/router").RouterProvider;
let backend: typeof import("@/lib/backend").backend;
let clearToasts: typeof import("@/components/ui/toast").clearToasts;
let readToasts: typeof import("@/components/ui/toast").readToasts;
let closeDom: () => void;
let event: (value: BackendEvent) => void;

const path = "notes.md";
const initial: LibraryDocument = {
  path,
  content: "server version one",
  hash: "hash-one",
};
const latest: LibraryDocument = {
  path,
  content: "server version two",
  hash: "hash-two",
};

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  closeDom = () => dom.window.close();
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("EventTarget", dom.window.EventTarget);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("AbortController", dom.window.AbortController);
  vi.stubGlobal("AbortSignal", dom.window.AbortSignal);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  await import("react");
  ({ act, cleanup, fireEvent, render, waitFor } = await import(
    "@testing-library/react"
  ));
  ({ DocumentPage } = await import("@/features/library/document"));
  ({ RouterProvider } = await import("@/app/router"));
  ({ backend } = await import("@/lib/backend"));
  ({ clearToasts, readToasts } = await import("@/components/ui/toast"));
}, 30000);

beforeEach(() => {
  clearToasts();
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    event = listener;
    return vi.fn();
  });
  vi.spyOn(backend, "readLibrary").mockResolvedValue(initial);
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  clearToasts();
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  closeDom();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <RouterProvider>
      <DocumentPage path={path} />
    </RouterProvider>,
  );
}

function editor(container: HTMLElement): HTMLTextAreaElement {
  const field = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Document"]',
  );
  if (!field) throw new Error("Document editor is missing");
  return field;
}

function conflict() {
  const item = readToasts().find(
    (value) => value.id === `document-conflict:${path}`,
  );
  if (!item?.action) throw new Error("Document conflict action is missing");
  return item;
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === "Save",
  );
  if (!button) throw new Error("Document save button is missing");
  return button;
}

async function openInitialDocument(container: HTMLElement) {
  await waitFor(() => expect(editor(container).value).toBe(initial.content));
}

describe("Live Library documents", () => {
  it("publishes fixed batches during continuous notifications and quick reads", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    vi.useFakeTimers();
    for (let index = 1; index <= 20; index += 1) {
      vi.mocked(backend.readLibrary).mockResolvedValue({
        ...initial,
        content: `version ${index}`,
        hash: `hash-${index}`,
      });
      await act(async () => {
        event({ type: "library.updated", path });
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(backend.readLibrary).toHaveBeenCalledTimes(
        1 + Math.floor((index * 50) / 150),
      );
      if (index % 3 === 0)
        expect(editor(view.container).value).toBe(`version ${index}`);
    }
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(backend.readLibrary).toHaveBeenCalledTimes(8);
    expect(editor(view.container).value).toBe("version 20");
  });

  it("completes a queued batch immediately on Turn completion", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    vi.useFakeTimers();
    vi.mocked(backend.readLibrary).mockResolvedValue(latest);
    await act(async () => {
      event({ type: "library.updated", path });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(backend.readLibrary).toHaveBeenCalledTimes(1);
    await act(async () => event({ type: "turn.finished", agent_id: 2 }));
    expect(backend.readLibrary).toHaveBeenCalledTimes(2);
    expect(editor(view.container).value).toBe(latest.content);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(backend.readLibrary).toHaveBeenCalledTimes(2);
  });

  it.each(["disconnect", "unmount"])(
    "clears a pending document batch on %s",
    async (condition) => {
      const view = mount();
      await openInitialDocument(view.container);
      vi.useFakeTimers();
      await act(async () => event({ type: "library.updated", path }));
      if (condition === "disconnect") {
        await act(async () => {
          event({ type: "connection.closed" });
          event({ type: "library.updated", path });
        });
      } else view.unmount();
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(backend.readLibrary).toHaveBeenCalledTimes(1);
      if (condition === "disconnect") {
        await act(async () => event({ type: "connection.restored" }));
        expect(backend.readLibrary).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("clears the previous path batch when the document changes", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    vi.useFakeTimers();
    await act(async () => event({ type: "library.updated", path }));
    vi.mocked(backend.readLibrary).mockResolvedValue({
      path: "next.md",
      content: "next document",
      hash: "next",
    });
    await act(async () => {
      view.rerender(
        <RouterProvider>
          <DocumentPage key="next.md" path="next.md" />
        </RouterProvider>,
      );
    });
    expect(backend.readLibrary).toHaveBeenCalledTimes(2);
    expect(editor(view.container).value).toBe("next document");
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(backend.readLibrary).toHaveBeenCalledTimes(2);
    expect(backend.readLibrary).toHaveBeenLastCalledWith("next.md");
  });

  it("refreshes the current path and leaves unrelated files alone", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    await act(async () => event({ type: "library.updated", path: "other.md" }));
    expect(backend.readLibrary).toHaveBeenCalledTimes(1);
    vi.mocked(backend.readLibrary).mockResolvedValueOnce(latest);
    await act(async () => event({ type: "library.updated", path }));
    await waitFor(() =>
      expect(editor(view.container).value).toBe(latest.content),
    );
  });

  it("publishes a completed read during continuing notifications and combines the next read", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    let finish!: (value: LibraryDocument) => void;
    let finishNext!: (value: LibraryDocument) => void;
    vi.mocked(backend.readLibrary)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNext = resolve;
          }),
      );
    await act(async () => event({ type: "library.updated", path }));
    await waitFor(() => expect(backend.readLibrary).toHaveBeenCalledTimes(2));
    await act(async () => {
      for (let index = 0; index < 100; index += 1)
        event({ type: "library.updated", path });
      event({ type: "turn.finished", agent_id: 2 });
    });
    expect(backend.readLibrary).toHaveBeenCalledTimes(2);
    await act(async () => finish(latest));
    expect(editor(view.container).value).toBe(latest.content);
    expect(backend.readLibrary).toHaveBeenCalledTimes(3);
    await act(async () =>
      finishNext({ ...latest, content: "final", hash: "final" }),
    );
    expect(editor(view.container).value).toBe("final");
    expect(backend.readLibrary).toHaveBeenCalledTimes(3);
  });

  it("preserves edits made while the current file is being refreshed", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    let finish!: (value: LibraryDocument) => void;
    vi.mocked(backend.readLibrary).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => event({ type: "library.updated", path }));
    await waitFor(() => expect(backend.readLibrary).toHaveBeenCalledTimes(2));
    fireEvent.change(editor(view.container), {
      target: { value: "local edit" },
    });
    await act(async () => finish(latest));
    expect(editor(view.container).value).toBe("local edit");
    expect(conflict().title).toBe("Saved elsewhere");
  });

  it("keeps a confirmed save when an older read completes later", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    let finish!: (value: LibraryDocument) => void;
    vi.mocked(backend.readLibrary).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => event({ type: "library.updated", path }));
    await waitFor(() => expect(backend.readLibrary).toHaveBeenCalledTimes(2));
    fireEvent.change(editor(view.container), {
      target: { value: "saved edit" },
    });
    vi.spyOn(backend, "writeLibrary").mockResolvedValueOnce({
      path,
      kind: "file",
      size: 10,
      modified_at: "now",
      hash: "saved",
    });
    fireEvent.click(saveButton(view.container));
    await waitFor(() => expect(saveButton(view.container).disabled).toBe(true));
    await act(async () => finish(initial));
    expect(editor(view.container).value).toBe("saved edit");
    expect(
      readToasts().some((item) => item.id === `document-conflict:${path}`),
    ).toBe(false);
  });

  it("ignores the old connection response after reconnecting", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    let finish!: (value: LibraryDocument) => void;
    vi.mocked(backend.readLibrary)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(latest);
    await act(async () => event({ type: "library.updated", path }));
    await waitFor(() => expect(backend.readLibrary).toHaveBeenCalledTimes(2));
    await act(async () => {
      event({ type: "connection.closed" });
      event({ type: "connection.restored" });
    });
    await waitFor(() =>
      expect(editor(view.container).value).toBe(latest.content),
    );
    await act(async () => finish(initial));
    expect(editor(view.container).value).toBe(latest.content);
  });
});

describe("Library document conflict recovery", () => {
  it("keeps edits until Reopen after a reconnect conflict", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    fireEvent.change(editor(view.container), {
      target: { value: "local edit" },
    });

    vi.mocked(backend.readLibrary).mockResolvedValueOnce(latest);
    await act(async () => {
      event({ type: "connection.restored" });
      await waitFor(() => expect(backend.readLibrary).toHaveBeenCalledTimes(2));
    });

    expect(editor(view.container).value).toBe("local edit");
    const notification = conflict();
    expect(notification.description).toBe(
      "Your unsaved changes are preserved. Reopen replaces them with the current document.",
    );

    vi.mocked(backend.readLibrary).mockResolvedValueOnce(latest);
    const readsBeforeReopen = vi.mocked(backend.readLibrary).mock.calls.length;
    notification.action?.onClick();
    await waitFor(() => {
      expect(vi.mocked(backend.readLibrary).mock.calls.length).toBeGreaterThan(
        readsBeforeReopen,
      );
    });
    await waitFor(() =>
      expect(editor(view.container).value).toBe(latest.content),
    );
  });

  it("keeps edits until Reopen after a save conflict", async () => {
    const view = mount();
    await openInitialDocument(view.container);
    fireEvent.change(editor(view.container), {
      target: { value: "local edit" },
    });
    vi.spyOn(backend, "writeLibrary").mockResolvedValueOnce({
      conflict: true,
      path,
      current_hash: latest.hash,
      current_content: latest.content,
    });

    fireEvent.click(saveButton(view.container));
    await waitFor(() => expect(backend.writeLibrary).toHaveBeenCalledOnce());

    expect(editor(view.container).value).toBe("local edit");
    const notification = conflict();
    expect(notification.description).toBe(
      "Your unsaved changes are preserved. Reopen replaces them with the current document.",
    );

    vi.mocked(backend.readLibrary).mockResolvedValueOnce(latest);
    const readsBeforeReopen = vi.mocked(backend.readLibrary).mock.calls.length;
    notification.action?.onClick();
    await waitFor(() => {
      expect(vi.mocked(backend.readLibrary).mock.calls.length).toBeGreaterThan(
        readsBeforeReopen,
      );
    });
    await waitFor(() =>
      expect(editor(view.container).value).toBe(latest.content),
    );
  });
});
