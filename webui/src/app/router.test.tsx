import { StrictMode, useCallback, useEffect, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { navIdOf, pageKeyOf, RouterProvider, useRouter } from "@/app/router";

let testing: typeof import("@testing-library/react");
let closeDom: () => void;

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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testing = await import("@testing-library/react");
}, 30000);

afterEach(async () => {
  testing.cleanup();
  await testing.act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function DraftGuard({
  dirty,
  busy,
  capture,
}: {
  dirty: boolean;
  busy: boolean;
  capture: (proceed: () => void) => void;
}) {
  const { registerNavigationBlocker } = useRouter();
  useEffect(
    () =>
      registerNavigationBlocker((_next, proceed) => {
        if (busy) return true;
        if (!dirty) return false;
        capture(proceed);
        return true;
      }),
    [dirty, busy, capture, registerNavigationBlocker],
  );
  return null;
}

function RouterProbe() {
  const { route, navigate } = useRouter();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [guard, setGuard] = useState(true);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const capture = useCallback((proceed: () => void) => {
    setPending(() => proceed);
  }, []);
  return (
    <>
      <output data-testid="route">{pageKeyOf(route)}</output>
      <input
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="button" onClick={() => setBusy(true)}>
        Save
      </button>
      <button type="button" onClick={() => setBusy(false)}>
        Save failed
      </button>
      <button
        type="button"
        onClick={() => {
          setBusy(false);
          setDraft("");
        }}
      >
        Save completed
      </button>
      <button type="button" onClick={() => setGuard((value) => !value)}>
        Toggle guard
      </button>
      <button type="button" onClick={() => navigate({ name: "usage" })}>
        All usage
      </button>
      <button type="button" onClick={() => navigate({ name: "member", id: 2 })}>
        Agent 2
      </button>
      <button type="button" onClick={() => navigate({ name: "member", id: 3 })}>
        Agent 3
      </button>
      {guard ? (
        <DraftGuard dirty={draft !== ""} busy={busy} capture={capture} />
      ) : null}
      {pending ? (
        <div role="dialog" aria-label="Unsaved draft">
          <button type="button" onClick={() => setPending(null)}>
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setPending(null);
              pending();
            }}
          >
            Discard
          </button>
        </div>
      ) : null}
    </>
  );
}

function mount() {
  testing.render(
    <StrictMode>
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>
    </StrictMode>,
  );
}

function click(name: string) {
  testing.fireEvent.click(testing.screen.getByRole("button", { name }));
}

function edit(value: string) {
  testing.fireEvent.change(testing.screen.getByLabelText("Draft"), {
    target: { value },
  });
}

function currentRoute() {
  return testing.screen.getByTestId("route").textContent;
}

describe("Navigation", () => {
  it("gives Usage an independent navigation and page identity", () => {
    expect(navIdOf({ name: "usage" })).toBe("usage");
    expect(pageKeyOf({ name: "usage" })).toBe("usage");
  });
  it("retains member identity and skips repeated identical navigation", () => {
    mount();
    click("All usage");
    expect(currentRoute()).toBe("usage");
    click("Agent 2");
    expect(currentRoute()).toBe("member:2");
    edit("unsaved");
    click("Agent 2");
    expect(testing.screen.queryByRole("dialog")).toBeNull();
    expect(currentRoute()).toBe("member:2");
    click("Agent 3");
    click("Discard");
    expect(currentRoute()).toBe("member:3");
    click("All usage");
    expect(currentRoute()).toBe("usage");
  });

  it("retains drafts on Keep editing and failed saves, then permits completed saves", () => {
    mount();
    edit("preserved draft");
    click("Agent 2");
    expect(currentRoute()).toBe("discussions");
    click("Keep editing");
    expect(
      (testing.screen.getByLabelText("Draft") as HTMLInputElement).value,
    ).toBe("preserved draft");
    click("Save");
    click("All usage");
    expect(currentRoute()).toBe("discussions");
    expect(testing.screen.queryByRole("dialog")).toBeNull();
    click("Save failed");
    click("Agent 3");
    expect(testing.screen.getByRole("dialog")).toBeTruthy();
    click("Keep editing");
    click("Save completed");
    click("All usage");
    expect(currentRoute()).toBe("usage");
  });

  it("clears unmounted blockers and registers once after StrictMode remount", () => {
    mount();
    edit("draft");
    click("Toggle guard");
    click("Agent 2");
    expect(currentRoute()).toBe("member:2");
    click("Toggle guard");
    click("Agent 3");
    expect(currentRoute()).toBe("member:2");
    expect(testing.screen.getByRole("dialog")).toBeTruthy();
    click("Discard");
    expect(currentRoute()).toBe("member:3");
  });
});
