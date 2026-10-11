import { StrictMode, useState } from "react";
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
import type { ProviderLayout } from "@/features/settings/model";
import type { BackendEvent, ModelCatalog } from "@/lib/backend";

let userEvent: typeof import("@testing-library/user-event").default;
let render: typeof import("@testing-library/react").render;
let screen: typeof import("@testing-library/react").screen;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let cleanup: typeof import("@testing-library/react").cleanup;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;
let ProviderLayoutPanel: typeof import("@/features/settings/model").ProviderLayoutPanel;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let backend: typeof import("@/lib/backend").backend;
let BackendError: typeof import("@/lib/backend").BackendError;
let closeDom: () => void;
let event: (event: BackendEvent) => void;
let saved: ModelCatalog;
let RouterProvider: typeof import("@/app/router").RouterProvider;
let useRouter: typeof import("@/app/router").useRouter;
let navigate: (route: import("@/app/router").Route) => void;
let hideEditor: () => void;

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  closeDom = () => dom.window.close();
  for (const name of [
    "window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "EventTarget",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "AbortController",
    "AbortSignal",
    "getComputedStyle",
  ] as const) {
    vi.stubGlobal(name, dom.window[name]);
  }
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ render, screen, fireEvent, cleanup, waitFor, act } = await import(
    "@testing-library/react"
  ));
  ({ RouterProvider, useRouter } = await import("@/app/router"));
  ({ ProviderLayoutPanel } = await import("@/features/settings/model"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
  ({ default: userEvent } = await import("@testing-library/user-event"));
  ({ backend, BackendError } = await import("@/lib/backend"));
}, 30000);

beforeEach(() => {
  saved = {
    version: 2,
    providers: [
      {
        id: "p1",
        name: "Example",
        api_type: "openai-chat",
        base_url: "https://example.test/v1",
        api_key_set: true,
        enabled: true,
      },
      {
        id: "p2",
        name: "Second",
        api_type: "google",
        base_url: "",
        api_key_set: false,
        enabled: true,
      },
    ],
    models: [
      {
        id: "m1",
        provider_id: "p1",
        name: "Example model",
        model: "remote-model",
        enabled: true,
        thinking_budget_tokens: null,
        thinking_options: ["default", "none", "high"],
      },
    ],
    default_model_id: null,
    default_thinking: "default",
    agent_configs: {},
  };
  vi.spyOn(backend, "modelCatalog").mockImplementation(async () => saved);
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    event = listener;
    return vi.fn();
  });
  vi.spyOn(backend, "configureModel").mockImplementation(
    async (action, id, values: Record<string, unknown> = {}) => {
      if (action === "save_provider") {
        saved = {
          ...saved,
          providers:
            id === null
              ? [
                  ...saved.providers,
                  {
                    id: "new-provider",
                    name: String(values.name),
                    api_type: String(values.api_type),
                    base_url: String(values.base_url),
                    api_key_set: Boolean(values.api_key),
                    enabled: Boolean(values.enabled),
                  },
                ]
              : saved.providers.map((provider) =>
                  provider.id === id
                    ? {
                        ...provider,
                        ...values,
                        api_key_set: values.clear_key
                          ? false
                          : Boolean(values.api_key) || provider.api_key_set,
                      }
                    : provider,
                ),
        };
      }
      if (action === "save_model")
        saved = {
          ...saved,
          models: saved.models.map((model) =>
            model.id === id ? { ...model, ...values } : model,
          ),
        };
      return saved;
    },
  );
  vi.spyOn(backend, "reportFailure").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
});
afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function mount(layout: ProviderLayout) {
  return render(
    <RouterProvider>
      <TooltipProvider>
        <ProviderLayoutPanel layout={layout} />
      </TooltipProvider>
    </RouterProvider>,
  );
}

function NavigationHarness({ layout }: { layout: ProviderLayout }) {
  const router = useRouter();
  const [visible, setVisible] = useState(true);
  navigate = router.navigate;
  hideEditor = () => setVisible(false);
  const route = router.route;
  return (
    <>
      <p>
        Current route: {route.name}
        {"section" in route ? `:${route.section}` : ""}
      </p>
      <button
        type="button"
        onClick={() => navigate({ name: "settings", section: "model" })}
      >
        Open model settings
      </button>
      {visible && route.name === "settings" && route.section === "model" ? (
        <ProviderLayoutPanel layout={layout} />
      ) : null}
    </>
  );
}

async function openSettings(layout: ProviderLayout) {
  render(
    <StrictMode>
      <RouterProvider>
        <TooltipProvider>
          <NavigationHarness layout={layout} />
        </TooltipProvider>
      </RouterProvider>
    </StrictMode>,
  );
  fireEvent.click(button("Open model settings"));
  await screen.findByText("Providers");
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value },
  });
}
function inputValue(name: string) {
  return (screen.getByRole("textbox", { name }) as HTMLInputElement).value;
}

function button(name: string) {
  return screen.getByRole("button", { name });
}
async function openProvider(layout: ProviderLayout) {
  mount(layout);
  await activateProvider(layout);
}

async function activateProvider(layout: ProviderLayout, name = "Example") {
  await screen.findByText("Providers");
  fireEvent.click(
    layout === "cards"
      ? screen.getAllByRole("button", { name: "Edit" })[0]
      : screen.getByRole("button", {
          name: layout === "split" ? name : new RegExp(`^${name}`),
        }),
  );
  await screen.findByLabelText("Provider name");
}

const layouts: ProviderLayout[] = ["cards", "split", "accordion"];

describe.each(layouts)("%s provider layout", (layout) => {
  it("waits for a real catalog and recovers from initial read failure", async () => {
    vi.mocked(backend.modelCatalog).mockRejectedValueOnce(
      new BackendError("timeout", "Catalog unavailable", true),
    );
    mount(layout);
    await screen.findByText("Catalog unavailable");
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByLabelText("Provider name")).toBeNull();
    fireEvent.click(button("Retry"));
    await screen.findByText("Providers");
    expect(button("Add")).toBeTruthy();
    expect(screen.queryByText("Catalog unavailable")).toBeNull();
    expect(backend.configureModel).not.toHaveBeenCalled();
  });

  it("refreshes shared model settings without replacing local drafts", async () => {
    await openProvider(layout);
    change("Provider name", "Local provider draft");
    fireEvent.click(button("Example modelremote-model"));
    change("Model name", "Local model draft");
    saved = {
      ...saved,
      providers: saved.providers.map((provider) =>
        provider.id === "p2"
          ? { ...provider, name: "Shared update" }
          : provider,
      ),
    };
    await act(async () =>
      event({ type: "settings.updated", section: "voice" }),
    );
    expect(backend.modelCatalog).toHaveBeenCalledTimes(1);
    await act(async () =>
      event({ type: "settings.updated", section: "model" }),
    );
    await screen.findByText("Shared update");
    expect(inputValue("Provider name")).toBe("Local provider draft");
    expect(inputValue("Model name")).toBe("Local model draft");
    expect(backend.modelCatalog).toHaveBeenCalledTimes(2);
  });

  it("defers shared refresh until an active save has settled", async () => {
    await openProvider(layout);
    change("Provider name", "Saved provider");
    let finish!: (value: ModelCatalog) => void;
    vi.mocked(backend.configureModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(button("Save"));
    await act(async () =>
      event({ type: "settings.updated", section: "model" }),
    );
    expect(backend.modelCatalog).toHaveBeenCalledTimes(1);
    const result = {
      ...saved,
      providers: saved.providers.map((provider) =>
        provider.id === "p1"
          ? { ...provider, name: "Saved provider" }
          : provider,
      ),
    };
    saved = {
      ...result,
      providers: result.providers.map((provider) =>
        provider.id === "p2"
          ? { ...provider, name: "Later shared update" }
          : provider,
      ),
    };
    await act(async () => finish(result));
    await screen.findByText("Later shared update");
    expect(backend.modelCatalog).toHaveBeenCalledTimes(2);
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });

  it("publishes each in-flight success while coalescing continuous notifications", async () => {
    const pending: ((catalog: ModelCatalog) => void)[] = [];
    vi.mocked(backend.modelCatalog).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    mount(layout);
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        for (let notification = 0; notification < 5; notification += 1)
          event({ type: "settings.updated", section: "model" });
      });
      expect(backend.modelCatalog).toHaveBeenCalledTimes(index + 1);
      const snapshot = {
        ...saved,
        providers: saved.providers.map((provider) =>
          provider.id === "p2"
            ? { ...provider, name: `Published ${index}` }
            : provider,
        ),
      };
      await act(async () => pending[index](snapshot));
      await screen.findByText(`Published ${index}`);
      expect(backend.modelCatalog).toHaveBeenCalledTimes(index + 2);
    }
    await act(async () => pending[3](saved));
    await screen.findByText("Second");
    expect(backend.modelCatalog).toHaveBeenCalledTimes(4);
  });

  it("isolates the old read finally from a restored connection's active read", async () => {
    const pending: ((catalog: ModelCatalog) => void)[] = [];
    vi.mocked(backend.modelCatalog).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    mount(layout);
    await act(async () => event({ type: "connection.restored" }));
    expect(backend.modelCatalog).toHaveBeenCalledTimes(2);
    await act(async () => pending[0]({ ...saved, providers: [] }));
    expect(screen.queryByText("Providers")).toBeNull();
    await act(async () => {
      event({ type: "settings.updated", section: "model" });
      event({ type: "settings.updated", section: "model" });
    });
    expect(backend.modelCatalog).toHaveBeenCalledTimes(2);
    await act(async () => pending[1](saved));
    await screen.findByText("Providers");
    expect(backend.modelCatalog).toHaveBeenCalledTimes(3);
    await act(async () => pending[2](saved));
    expect(backend.modelCatalog).toHaveBeenCalledTimes(3);
  });

  it("ignores a read started before a confirmed save", async () => {
    await openProvider(layout);
    let finish!: (catalog: ModelCatalog) => void;
    vi.mocked(backend.modelCatalog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const previous = saved;
    await act(async () =>
      event({ type: "settings.updated", section: "model" }),
    );
    change("Provider name", "Confirmed name");
    fireEvent.click(button("Save"));
    await waitFor(() => expect(saved.providers[0].name).toBe("Confirmed name"));
    await act(async () => finish(previous));
    if (layout === "cards") await activateProvider(layout, "Confirmed name");
    expect(inputValue("Provider name")).toBe("Confirmed name");
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });

  it("does not consume a queued refresh after unmount", async () => {
    let finish!: (catalog: ModelCatalog) => void;
    vi.mocked(backend.modelCatalog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount(layout);
    await act(async () =>
      event({ type: "settings.updated", section: "model" }),
    );
    view.unmount();
    await act(async () => finish(saved));
    expect(backend.modelCatalog).toHaveBeenCalledTimes(1);
  });

  it("retains a deleted provider's identity and draft until explicit discard", async () => {
    saved = { ...saved, models: [] };
    await openProvider(layout);
    change("Provider name", "Retained provider draft");
    change("Base URL", "https://draft.test/v1");
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "test-draft-key" },
    });
    saved = {
      ...saved,
      providers: saved.providers.filter((item) => item.id !== "p1"),
    };
    await act(async () =>
      event({ type: "settings.updated", section: "model" }),
    );
    await screen.findByText(/This provider no longer exists/);
    expect(inputValue("Provider name")).toBe("Retained provider draft");
    expect(inputValue("Base URL")).toBe("https://draft.test/v1");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "test-draft-key",
    );
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    const form = screen.getByLabelText("Provider name").closest("form");
    if (!form) throw new Error("Provider form is missing");
    fireEvent.submit(form);
    expect(backend.configureModel).not.toHaveBeenCalled();
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Keep Editing"));
    expect(inputValue("Provider name")).toBe("Retained provider draft");
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Discard"));
    expect(screen.queryByLabelText("Provider name")).toBeNull();
    expect(screen.queryByText(/This provider no longer exists/)).toBeNull();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    fireEvent.click(button("Add"));
    change("Provider name", "Explicit new provider");
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        null,
        expect.objectContaining({ name: "Explicit new provider" }),
      ),
    );
  });

  it("retains a deleted model's draft and invalidates its pending test", async () => {
    await openProvider(layout);
    change("Provider name", "Other provider draft");
    fireEvent.click(button("Example modelremote-model"));
    change("Model name", "Retained model draft");
    let finish!: (value: { latency_ms: number; reply: string }) => void;
    vi.spyOn(backend, "call").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(button("Test"));
    saved = { ...saved, models: [] };
    await act(async () =>
      event({ type: "settings.updated", section: "model" }),
    );
    await screen.findByText(
      "This model no longer exists. Your draft is retained.",
    );
    expect(inputValue("Model name")).toBe("Retained model draft");
    expect((button("Save model") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Test") as HTMLButtonElement).disabled).toBe(true);
    const form = screen
      .getByRole("textbox", { name: "Model name" })
      .closest("form");
    if (!form) throw new Error("Model form is missing");
    fireEvent.submit(form);
    await act(async () => finish({ latency_ms: 23, reply: "Deleted result" }));
    expect(screen.queryByText("23 ms · Deleted result")).toBeNull();
    expect(backend.configureModel).not.toHaveBeenCalled();
    fireEvent.click(button("Close editor"));
    fireEvent.click(button("Keep Editing"));
    expect(inputValue("Model name")).toBe("Retained model draft");
    fireEvent.click(button("Close editor"));
    fireEvent.click(button("Discard"));
    expect(screen.queryByRole("textbox", { name: "Model name" })).toBeNull();
    expect(inputValue("Provider name")).toBe("Other provider draft");
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Discard"));
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("retains a new model draft when its saved provider is deleted", async () => {
    saved = { ...saved, models: [] };
    await openProvider(layout);
    fireEvent.click(button("Add model"));
    change("Model name", "New model draft");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Remote model ID" }),
      {
        target: { value: "new-remote-model" },
      },
    );
    saved = {
      ...saved,
      providers: saved.providers.filter((item) => item.id !== "p1"),
    };
    await act(async () =>
      event({ type: "settings.updated", section: "model" }),
    );
    await screen.findByText(/This provider no longer exists/);
    expect(inputValue("Model name")).toBe("New model draft");
    expect(
      (
        screen.getByRole("combobox", {
          name: "Remote model ID",
        }) as HTMLInputElement
      ).value,
    ).toBe("new-remote-model");
    const form = screen
      .getByRole("textbox", { name: "Model name" })
      .closest("form");
    if (!form) throw new Error("Model form is missing");
    fireEvent.submit(form);
    expect(backend.configureModel).not.toHaveBeenCalled();
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Keep Editing"));
    expect(inputValue("Model name")).toBe("New model draft");
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Discard"));
    expect(screen.queryByLabelText("Model name")).toBeNull();
  });

  it("retains responsive component constraints at narrow viewport sizes", async () => {
    for (const width of [375, 640]) {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      const view = mount(layout);
      await activateProvider(layout);
      const root = view.container.querySelector("[data-provider-layout]");
      expect(root?.className).toContain("min-w-0");
      expect(
        screen.getByLabelText("Provider name").closest("form")?.className,
      ).toContain("flex-col");
      if (layout === "cards") {
        expect(screen.getByRole("dialog").className).toContain(
          "calc(100vw-32px)",
        );
      } else if (layout === "split") {
        expect(
          button("‹ Back to Providers").parentElement?.className,
        ).toContain("md:hidden");
        expect(
          view.container.querySelector("[data-provider-list]")?.className,
        ).toContain("hidden md:flex");
      } else {
        expect(
          screen.getByRole("button", { name: /Example.*OpenAI Chat/ })
            .className,
        ).toContain("flex-wrap");
      }
      view.unmount();
    }
  });

  it("protects all drafts while changing Settings sections and pages", async () => {
    await openSettings(layout);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Thinking effort" }),
      {
        target: { value: "high" },
      },
    );
    await activateProvider(layout);
    change("Provider name", "Provider draft");
    fireEvent.click(button("Example modelremote-model"));
    change("Model name", "Model draft");
    await act(async () => navigate({ name: "settings", section: "model" }));
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    await act(async () => navigate({ name: "settings", section: "execution" }));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(screen.getByText("Current route: settings:model")).toBeTruthy();
    fireEvent.click(button("Keep Editing"));
    expect(inputValue("Provider name")).toBe("Provider draft");
    expect(inputValue("Model name")).toBe("Model draft");
    await act(async () => navigate({ name: "members" }));
    fireEvent.click(button("Discard"));
    expect(screen.getByText("Current route: members")).toBeTruthy();
    expect(screen.queryByLabelText("Provider name")).toBeNull();
    expect(backend.configureModel).not.toHaveBeenCalled();
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });

  it("protects a model draft when provider fields are unchanged", async () => {
    await openSettings(layout);
    await activateProvider(layout);
    fireEvent.click(button("Example modelremote-model"));
    change("Model name", "Model draft");
    await act(async () => navigate({ name: "members" }));
    fireEvent.click(button("Keep Editing"));
    expect(inputValue("Provider name")).toBe("Example");
    expect(inputValue("Model name")).toBe("Model draft");
    await act(async () => navigate({ name: "settings", section: "execution" }));
    fireEvent.click(button("Discard"));
    expect(screen.getByText("Current route: settings:execution")).toBeTruthy();
  });

  it("keeps global selection input and applies the latest navigation target", async () => {
    await openSettings(layout);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Thinking effort" }),
      {
        target: { value: "high" },
      },
    );
    await act(async () => navigate({ name: "settings", section: "execution" }));
    fireEvent.click(button("Keep Editing"));
    expect(
      (
        screen.getByRole("combobox", {
          name: "Thinking effort",
        }) as HTMLSelectElement
      ).value,
    ).toBe("high");
    await act(async () => navigate({ name: "settings", section: "execution" }));
    await act(async () => navigate({ name: "members" }));
    fireEvent.click(button("Discard"));
    expect(screen.getByText("Current route: members")).toBeTruthy();
    fireEvent.click(button("Open model settings"));
    await screen.findByText("Providers");
    expect(
      (
        screen.getByRole("combobox", {
          name: "Thinking effort",
        }) as HTMLSelectElement
      ).value,
    ).toBe("default");
    expect(backend.configureModel).not.toHaveBeenCalled();
  });

  it("blocks navigation during saving and permits navigation after saving", async () => {
    await openSettings(layout);
    await activateProvider(layout);
    change("Provider name", "Saved provider");
    let finish!: (value: ModelCatalog) => void;
    vi.mocked(backend.configureModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const form = screen.getByLabelText("Provider name").closest("form");
    if (!form) throw new Error("Provider form is missing");
    await act(async () => {
      fireEvent.submit(form);
      navigate({ name: "members" });
    });
    expect(screen.getByText("Current route: settings:model")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    await act(async () =>
      finish({
        ...saved,
        providers: saved.providers.map((provider) =>
          provider.id === "p1"
            ? { ...provider, name: "Saved provider" }
            : provider,
        ),
      }),
    );
    await act(async () => navigate({ name: "members" }));
    expect(screen.getByText("Current route: members")).toBeTruthy();
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });

  it("cleans navigation and browser leave protection on StrictMode unmount", async () => {
    await openSettings(layout);
    await activateProvider(layout);
    change("Provider name", "Draft");
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    await act(async () => hideEditor());
    await act(async () => navigate({ name: "members" }));
    expect(screen.getByText("Current route: members")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("keeps provider and model drafts separate while saving a provider", async () => {
    await openProvider(layout);
    change("Provider name", "Edited provider");
    fireEvent.click(
      screen.getByRole("button", { name: "Example modelremote-model" }),
    );
    change("Model name", "Model draft");
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        "p1",
        expect.objectContaining({ name: "Edited provider" }),
      ),
    );
    expect(inputValue("Model name")).toBe("Model draft");
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before discarding changes", async () => {
    await openProvider(layout);
    change("Provider name", "Draft name");
    fireEvent.click(button("Cancel"));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(button("Keep Editing"));
    expect(inputValue("Provider name")).toBe("Draft name");
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Discard"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Provider name")).toBeNull(),
    );
  });

  it("keeps input and focus after a business save error", async () => {
    await openProvider(layout);
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("provider_in_use", "This provider is in use."),
    );
    const field = screen.getByLabelText("Provider name");
    change("Provider name", "Still here");
    field.focus();
    const form = field.closest("form");
    if (!form) throw new Error("Provider form is missing");
    fireEvent.submit(form);
    await screen.findAllByText("This provider is in use.");
    expect((field as HTMLInputElement).value).toBe("Still here");
    expect(document.activeElement).toBe(field);
  });

  it("prevents provider deletion while models exist and blocks tests on connection drafts", async () => {
    await openProvider(layout);
    expect((button("Delete") as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Remove this provider's models first."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Example modelremote-model" }),
    );
    change("Base URL", "https://changed.test");
    expect((button("Test") as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getAllByText("Save provider connection first.").length,
    ).toBeGreaterThan(0);
    expect(backend.configureModel).not.toHaveBeenCalled();
  });

  it("reads saved configuration after an unknown write without repeating creation", async () => {
    mount(layout);
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    change("Provider name", "Maybe saved");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("connection_lost", "Save result unknown", true),
    );
    fireEvent.click(button("Save"));
    await waitFor(() => expect(backend.modelCatalog).toHaveBeenCalledTimes(2));
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
    expect(button("Save").closest("fieldset")?.disabled).toBe(true);
    await act(async () => event({ type: "connection.restored" }));
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
    expect(inputValue("Provider name")).toBe("Maybe saved");
  });
});

describe.each(layouts)("%s complete operations", (layout) => {
  it.each(["OpenAI Chat", "OpenAI Responses", "Anthropic", "Google"])(
    "creates a provider with %s",
    async (protocol) => {
      mount(layout);
      fireEvent.click(await screen.findByRole("button", { name: "Add" }));
      change("Provider name", "New provider");
      fireEvent.click(button(protocol));
      fireEvent.click(button("Save"));
      await waitFor(() =>
        expect(backend.configureModel).toHaveBeenCalledWith(
          "save_provider",
          null,
          expect.objectContaining({
            name: "New provider",
            api_type: {
              "OpenAI Chat": "openai-chat",
              "OpenAI Responses": "openai-responses",
              Anthropic: "anthropic",
              Google: "google",
            }[protocol],
          }),
        ),
      );
      if (layout === "cards") {
        await screen.findByText("New provider");
        expect(screen.queryByLabelText("Provider name")).toBeNull();
      } else {
        await waitFor(() =>
          expect(screen.getByLabelText("Provider name")).toBeTruthy(),
        );
      }
      expect(
        vi.mocked(backend.configureModel).mock.calls[0][2],
      ).not.toHaveProperty("clear_key");
    },
  );

  it("preserves an empty key and submits explicit key clearing", async () => {
    await openProvider(layout);
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        "p1",
        expect.objectContaining({ api_key: "", clear_key: false }),
      ),
    );
    if (layout === "cards") {
      await waitFor(() =>
        expect(screen.queryByLabelText("Provider name")).toBeNull(),
      );
      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    } else {
      await waitFor(() =>
        expect(button("Save").closest("fieldset")?.disabled).toBe(false),
      );
    }
    fireEvent.click(screen.getByLabelText("Clear stored key"));
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenLastCalledWith(
        "save_provider",
        "p1",
        expect.objectContaining({ clear_key: true }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Clear stored key")).toBeNull(),
    );
  });

  it("tests an existing model using its saved ID and current thinking", async () => {
    await openProvider(layout);
    vi.spyOn(backend, "call").mockResolvedValue({
      latency_ms: 12,
      reply: "OK",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Example modelremote-model" }),
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Test thinking effort" }),
      { target: { value: "high" } },
    );
    fireEvent.click(button("Test"));
    await waitFor(() =>
      expect(backend.call).toHaveBeenCalledWith("settings.test_model", {
        model_id: "m1",
        thinking: "high",
      }),
    );
    await screen.findByText("12 ms · OK");
    expect(backend.configureModel).not.toHaveBeenCalled();
    change("Provider name", "Name draft");
    expect((button("Test") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Remote model ID" }),
      { target: { value: "changed-remote" } },
    );
    expect((button("Test") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save model changes first.")).toBeTruthy();
  });

  it("tests a new model using the saved provider and draft model parameters", async () => {
    await openProvider(layout);
    vi.spyOn(backend, "call").mockResolvedValue({ latency_ms: 9, reply: "OK" });
    fireEvent.click(button("Add model"));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Remote model ID" }),
      { target: { value: "new-remote" } },
    );
    fireEvent.click(button("Test"));
    await waitFor(() =>
      expect(backend.call).toHaveBeenCalledWith("settings.test_model", {
        provider_id: "p1",
        model: "new-remote",
        thinking: "default",
        thinking_budget_tokens: null,
      }),
    );
    expect(backend.configureModel).not.toHaveBeenCalled();
  });

  it("submits Enter through the owning model form without saving provider drafts", async () => {
    await openProvider(layout);
    change("Provider name", "Provider draft");
    fireEvent.click(
      screen.getByRole("button", { name: "Example modelremote-model" }),
    );
    change("Model name", "Renamed model");
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Model name" }));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_model",
        "m1",
        expect.objectContaining({ name: "Renamed model" }),
      ),
    );
    expect(inputValue("Provider name")).toBe("Provider draft");
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });

  it("keeps model input when deletion fails a reference check", async () => {
    await openProvider(layout);
    fireEvent.click(
      screen.getByRole("button", { name: "Example modelremote-model" }),
    );
    change("Model name", "Model draft");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("model_in_use", "The model is selected by an Agent."),
    );
    fireEvent.click(button("Delete model"));
    await screen.findByRole("dialog", { name: "Delete Example model?" });
    fireEvent.click(button("Delete"));
    await screen.findAllByText("The model is selected by an Agent.");
    expect(inputValue("Model name")).toBe("Model draft");
  });

  it.each(["anthropic", "google"])(
    "tests explicit token budgets for %s without saving",
    async (apiType) => {
      saved.providers[0].api_type = apiType;
      await openProvider(layout);
      vi.spyOn(backend, "call").mockResolvedValue({
        latency_ms: 8,
        reply: "OK",
      });
      fireEvent.click(button("Add model"));
      fireEvent.change(
        screen.getByRole("combobox", { name: "Remote model ID" }),
        { target: { value: "budget-model" } },
      );
      fireEvent.change(
        screen.getByRole("spinbutton", { name: "Thinking token budget" }),
        { target: { value: "2048" } },
      );
      fireEvent.change(
        screen.getByRole("combobox", { name: "Test thinking effort" }),
        { target: { value: "budget" } },
      );
      fireEvent.click(button("Test"));
      await waitFor(() =>
        expect(backend.call).toHaveBeenCalledWith("settings.test_model", {
          provider_id: "p1",
          model: "budget-model",
          thinking: "budget",
          thinking_budget_tokens: 2048,
        }),
      );
      expect(backend.configureModel).not.toHaveBeenCalled();
    },
  );

  it("ignores a test response after the tested model input changes", async () => {
    await openProvider(layout);
    let finish!: (result: { latency_ms: number; reply: string }) => void;
    vi.spyOn(backend, "call").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(button("Add model"));
    const remote = screen.getByRole("combobox", { name: "Remote model ID" });
    fireEvent.change(remote, { target: { value: "first-model" } });
    fireEvent.click(button("Test"));
    fireEvent.change(remote, { target: { value: "second-model" } });
    await act(async () => finish({ latency_ms: 17, reply: "Old result" }));
    expect(screen.queryByText("17 ms · Old result")).toBeNull();
  });

  it("requires a confirmation to delete a provider with no models", async () => {
    saved.models = [];
    await openProvider(layout);
    vi.mocked(backend.configureModel).mockImplementationOnce(async () => {
      saved = { ...saved, providers: saved.providers.slice(1) };
      return saved;
    });
    fireEvent.click(button("Delete"));
    await screen.findByRole("dialog", { name: "Delete Example?" });
    expect(backend.configureModel).not.toHaveBeenCalled();
    fireEvent.click(button("Delete"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "delete_provider",
        "p1",
        {},
      ),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Provider name")).toBeNull(),
    );
  });

  it("validates whitespace names locally and retains all fields", async () => {
    await openProvider(layout);
    change("Provider name", "   ");
    fireEvent.click(button("Save"));
    expect(
      screen.getByLabelText("Provider name").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Provider name"));
    expect(backend.configureModel).not.toHaveBeenCalled();
  });

  it("lists models with saved provider ID and keeps directory errors local", async () => {
    await openProvider(layout);
    vi.spyOn(backend, "call").mockRejectedValueOnce(
      new BackendError("model_listing", "Directory unavailable"),
    );
    fireEvent.click(button("Add model"));
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await waitFor(() =>
      expect(backend.call).toHaveBeenCalledWith("settings.list_models", {
        provider_id: "p1",
      }),
    );
    await screen.findByText("Directory unavailable");
    expect(backend.configureModel).not.toHaveBeenCalled();
  });

  it("reports failed model tests while retaining unsaved input", async () => {
    await openProvider(layout);
    vi.spyOn(backend, "call").mockRejectedValueOnce(
      new BackendError("model_test", "The model rejected the request."),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Example modelremote-model" }),
    );
    change("Model name", "Local name");
    fireEvent.click(button("Test"));
    await screen.findByText("The model rejected the request.");
    expect(inputValue("Model name")).toBe("Local name");
  });

  it("does not repeat a pending save", async () => {
    await openProvider(layout);
    let finish!: (catalog: ModelCatalog) => void;
    vi.mocked(backend.configureModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    change("Provider name", "Pending");
    const form = screen.getByLabelText("Provider name").closest("form");
    if (!form) throw new Error("Provider form is missing");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
    await act(async () => finish(saved));
  });

  it("removes browser leave protection after drafts are discarded", async () => {
    await openProvider(layout);
    change("Provider name", "Draft");
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Discard"));
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("keeps drafts through reconnect and ignores an older initial read", async () => {
    let resolve!: (catalog: ModelCatalog) => void;
    vi.mocked(backend.modelCatalog).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount(layout);
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    await act(async () => event({ type: "connection.restored" }));
    await screen.findByText("Providers");
    await act(async () => resolve({ ...saved, providers: [] }));
    expect(screen.getByText("Providers")).toBeTruthy();
    fireEvent.click(button("Add"));
    change("Provider name", "Unsaved");
    await act(async () => event({ type: "connection.restored" }));
    expect(inputValue("Provider name")).toBe("Unsaved");
  });
});

it.each<ProviderLayout>(["split", "accordion"])(
  "%s keeps list focus until keyboard activation",
  async (layout) => {
    mount(layout);
    await screen.findByText("Providers");
    const first = screen.getByRole("button", {
      name: layout === "split" ? "Example" : /Example.*OpenAI Chat/,
    });
    const second = screen.getByRole("button", {
      name: layout === "split" ? "Second" : /Second.*Google/,
    });
    first.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    expect(screen.queryByLabelText("Provider name")).toBeNull();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByLabelText("Provider name"));
  },
);

it("loads the same saved configuration when moving between candidate views", async () => {
  for (const [index, layout] of layouts.entries()) {
    const view = mount(layout);
    const previous = index === 0 ? "Example" : `Shared provider ${index - 1}`;
    await activateProvider(layout, previous);
    expect(inputValue("Provider name")).toBe(previous);
    change("Provider name", `Shared provider ${index}`);
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(saved.providers[0].name).toBe(`Shared provider ${index}`),
    );
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledTimes(index + 1),
    );
    view.unmount();
  }
});

it("retains global defaults while changing the selected provider", async () => {
  mount("split");
  await screen.findByText("Providers");
  fireEvent.change(screen.getByRole("combobox", { name: "Thinking effort" }), {
    target: { value: "high" },
  });
  fireEvent.click(button("Example"));
  fireEvent.click(button("Second"));
  expect(
    (
      screen.getByRole("combobox", {
        name: "Thinking effort",
      }) as HTMLSelectElement
    ).value,
  ).toBe("high");
  expect(backend.configureModel).not.toHaveBeenCalled();
});

it.each<ProviderLayout>(["split", "accordion"])(
  "%s inline enabled saves only enabled and preserves both drafts",
  async (layout) => {
    await openProvider(layout);
    change("Provider name", "Provider draft");
    fireEvent.click(
      screen.getByRole("button", { name: "Example modelremote-model" }),
    );
    change("Model name", "Model draft");
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Example" }));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        "p1",
        { enabled: false },
      ),
    );
    expect(inputValue("Provider name")).toBe("Provider draft");
    expect(inputValue("Model name")).toBe("Model draft");
  },
);
