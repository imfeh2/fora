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
import { backend, type ModelCatalog } from "@/lib/backend";

let dom: {
  window: Window & {
    close: () => void;
    HTMLElement: typeof HTMLElement;
    Node: typeof Node;
    MutationObserver: typeof MutationObserver;
    Event: typeof Event;
    EventTarget: typeof EventTarget;
    CustomEvent: typeof CustomEvent;
    MouseEvent: typeof MouseEvent;
    KeyboardEvent: typeof KeyboardEvent;
    AbortController: typeof AbortController;
    AbortSignal: typeof AbortSignal;
  };
};
let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let screen: typeof import("@testing-library/react").screen;
let waitFor: typeof import("@testing-library/react").waitFor;
let within: typeof import("@testing-library/react").within;
let App: typeof import("@/App").default;
let RouterProvider: typeof import("@/app/router").RouterProvider;
let SettingsPage: typeof import("@/features/settings/page").SettingsPage;
let renderToStaticMarkup: typeof import("react-dom/server").renderToStaticMarkup;
let isSettingsSaving: typeof import("@/features/settings/saver").isSettingsSaving;

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
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
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
  for (const key of ["NodeFilter", "HTMLInputElement", "HTMLFormElement"])
    vi.stubGlobal(key, Reflect.get(dom.window, key));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  dom.window.requestAnimationFrame = vi.fn();
  dom.window.cancelAnimationFrame = vi.fn();
  await import("react");
  ({ isSettingsSaving } = await import("@/features/settings/saver"));
  const testing = await import("@testing-library/react");
  act = testing.act;
  cleanup = testing.cleanup;
  fireEvent = testing.fireEvent;
  render = testing.render;
  screen = testing.screen;
  waitFor = testing.waitFor;
  within = testing.within;
  ({ default: App } = await import("@/App"));
  ({ RouterProvider } = await import("@/app/router"));
  ({ SettingsPage } = await import("@/features/settings/page"));
  ({ renderToStaticMarkup } = await import("react-dom/server"));
}, 30000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const modelCatalog: ModelCatalog = {
  version: 2,
  providers: [
    {
      id: "provider-a",
      name: "Provider A",
      api_type: "openai-chat",
      base_url: "http://127.0.0.1:1",
      api_key_set: false,
      enabled: false,
    },
    {
      id: "provider-b",
      name: "Provider B",
      api_type: "openai-chat",
      base_url: "http://127.0.0.1:1",
      api_key_set: false,
      enabled: false,
    },
  ],
  models: [],
  default_model_id: null,
  default_thinking: "default",
  agent_configs: {},
};

const agentSettings = {
  context_window_tokens: 8192,
  memory_index_bytes: 64000,
  exchange_nudge_after: 24,
  idle_streak_after: 3,
  no_tool_turns_before_pause: 5,
  max_concurrent_turns: 4,
  token_limit: 100000,
  request_limit: 0,
};

class ResizeObserverStub {
  observe() {}

  unobserve() {}

  disconnect() {}
}

async function prepareApplication() {
  vi.spyOn(backend, "connect").mockResolvedValue();
  vi.spyOn(backend, "onEvent").mockReturnValue(vi.fn());
  vi.spyOn(backend, "onFailure").mockReturnValue(vi.fn());
  vi.spyOn(backend, "organization").mockResolvedValue({
    id: 1,
    uuid: "test-organization",
    members: [],
    human_id: 1,
    token_limit: null,
  });
  vi.spyOn(backend, "discussions").mockResolvedValue([]);
  vi.spyOn(backend, "modelCatalog").mockResolvedValue(modelCatalog);
  vi.spyOn(backend, "settings").mockImplementation(async (section) => {
    if (section === "agent") return agentSettings;
    if (section === "observability") {
      return {
        enabled: false,
        base_url: "https://cloud.langfuse.com",
        keys_set: true,
      };
    }
    return {};
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  await act(async () => {
    render(<App />);
  });
}

async function getSettingsNavigation() {
  const navigation = await screen.findByLabelText("Settings", {
    selector: "nav",
  });
  return within(navigation).getByRole("button", { name: "Settings" });
}

async function openSettings(section: "model" | "agent") {
  fireEvent.click(await getSettingsNavigation());
  const tablist = await screen.findByRole("tablist", { name: "Settings" });
  const tabs = within(tablist);
  const tab = await tabs.findByRole("tab", { name: "Model" });
  if (section === "agent") {
    fireEvent.click(tabs.getByRole("tab", { name: "Agent" }));
    await screen.findByLabelText("Model requests per Turn");
  }
  return tab;
}

function flushScheduledWork() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  cleanup();
  await act(async () => {
    await flushScheduledWork();
  });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await act(async () => {
    await flushScheduledWork();
  });
  dom.window.close();
  vi.unstubAllGlobals();
});

describe("Settings save navigation", () => {
  it("stays blocked until every active save finishes", () => {
    expect(isSettingsSaving({})).toBe(false);
    expect(isSettingsSaving({ model: true, agent: false })).toBe(true);
    expect(isSettingsSaving({ model: false, agent: false })).toBe(false);
  });
});

describe("mounted Settings interactions", () => {
  beforeEach(prepareApplication);

  it("protects new Model drafts and resets them after explicit discard and provider change", async () => {
    await openSettings("model");
    await screen.findByRole("group", { name: "Model settings" });
    fireEvent.click(
      screen.getByRole("button", { name: /^Provider A.*openai-chat/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: "A draft" } });
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "remote-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
    expect(
      (screen.getByLabelText("Display name") as HTMLInputElement).value,
    ).toBe("A draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Display name")).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Provider B.*openai-chat/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(
      ((await screen.findByLabelText("Display name")) as HTMLInputElement)
        .value,
    ).toBe("");
    expect((screen.getByLabelText("Model ID") as HTMLInputElement).value).toBe(
      "",
    );
    expect(
      (screen.getByRole("checkbox", { name: "Enabled" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("blocks Tabs and Sidebar through delayed write and readback", async () => {
    const readback = deferred<Record<string, unknown>>();
    const update = deferred<Record<string, unknown>>();
    let agentReads = 0;
    vi.spyOn(backend, "settings").mockImplementation(async (section) => {
      if (section === "agent") {
        agentReads += 1;
        return agentReads === 1 ? agentSettings : readback.promise;
      }
      return {};
    });
    vi.spyOn(backend, "updateSettings").mockReturnValueOnce(update.promise);

    await openSettings("agent");
    const requestLimit = screen.getByLabelText("Model requests per Turn");
    fireEvent.change(requestLimit, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const agentTab = screen.getByRole("tab", { name: "Agent" });
    const settingsNavigation = await getSettingsNavigation();
    await waitFor(() => {
      expect((agentTab as HTMLButtonElement).disabled).toBe(true);
      expect(settingsNavigation.closest("[inert]")).not.toBeNull();
    });

    await act(async () => {
      update.resolve({});
      await update.promise;
    });
    await waitFor(() => expect(agentReads).toBe(2));
    expect((agentTab as HTMLButtonElement).disabled).toBe(true);
    expect(settingsNavigation.closest("[inert]")).not.toBeNull();

    await act(async () => {
      readback.resolve({ ...agentSettings, request_limit: 7 });
      await readback.promise;
    });
    await waitFor(() => {
      expect((agentTab as HTMLButtonElement).disabled).toBe(false);
      expect(settingsNavigation.closest("[inert]")).toBeNull();
    });
    expect((requestLimit as HTMLInputElement).value).toBe("7");
  });

  it("restores navigation and preserves the draft after a failed write", async () => {
    vi.spyOn(backend, "updateSettings").mockRejectedValueOnce(
      new Error("offline"),
    );
    await openSettings("agent");
    const requestLimit = screen.getByLabelText("Model requests per Turn");
    fireEvent.change(requestLimit, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Could not save");
    expect(
      (screen.getByRole("tab", { name: "Agent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect((await getSettingsNavigation()).closest("[inert]")).toBeNull();
    expect((requestLimit as HTMLInputElement).value).toBe("9");
  });
});

describe("Settings page", () => {
  it("shows one tab per section and the requested panel", () => {
    const html = renderToStaticMarkup(
      <RouterProvider>
        <SettingsPage section="agent" />
      </RouterProvider>,
    );
    expect(html).toMatch(/<h1\b[^>]*>Settings<\/h1>/);
    for (const label of ["Model", "Execution", "Agent", "Langfuse"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Loading Agent settings"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("<input");
  });

  it("shows voice form placeholders before settings arrive", () => {
    const html = renderToStaticMarkup(
      <RouterProvider>
        <SettingsPage section="voice" />
      </RouterProvider>,
    );
    expect(html).toContain('aria-label="Loading voice settings"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Start microphone test");
    expect(html).not.toContain("Whisper");
    expect(html).not.toContain("Download model");
    expect(html).not.toContain("<select");
  });
});
