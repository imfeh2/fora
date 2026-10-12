import { StrictMode } from "react";
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
import type { BackendEvent, ModelCatalog, ProviderConfig } from "@/lib/backend";

let render: typeof import("@testing-library/react").render;
let screen: typeof import("@testing-library/react").screen;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let cleanup: typeof import("@testing-library/react").cleanup;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;
let within: typeof import("@testing-library/react").within;
let userEvent: typeof import("@testing-library/user-event").default;
let ModelPanel: typeof import("@/features/settings/model").ModelPanel;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let RouterProvider: typeof import("@/app/router").RouterProvider;
let useRouter: typeof import("@/app/router").useRouter;
let backend: typeof import("@/lib/backend").backend;
let BackendError: typeof import("@/lib/backend").BackendError;
let closeDom: () => void;
let saved: ModelCatalog;
let listeners: Set<(event: BackendEvent) => void>;
let navigate: (route: import("@/app/router").Route) => void;

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
    "HTMLFormElement",
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
  ] as const)
    vi.stubGlobal(name, dom.window[name]);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ render, screen, fireEvent, cleanup, waitFor, act, within } = await import(
    "@testing-library/react"
  ));
  ({ default: userEvent } = await import("@testing-library/user-event"));
  ({ ModelPanel } = await import("@/features/settings/model"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
  ({ RouterProvider, useRouter } = await import("@/app/router"));
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
        extra_body: { seed: 2 },
      },
      {
        id: "p2",
        name: "Second",
        api_type: "google",
        base_url: "",
        api_key_set: false,
        enabled: false,
        extra_body: {},
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
  listeners = new Set();
  vi.spyOn(backend, "modelCatalog").mockImplementation(async () => saved);
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.spyOn(backend, "reportFailure").mockImplementation(() => {});
  vi.spyOn(backend, "call").mockResolvedValue({
    models: ["remote-model", "new-remote"],
    latency_ms: 12,
    reply: "OK",
  });
  vi.spyOn(backend, "configureModel").mockImplementation(
    async (action, id, values: Record<string, unknown> = {}) => {
      if (action === "save_provider") {
        if (id === null)
          saved = {
            ...saved,
            providers: [
              ...saved.providers,
              {
                id: "new-provider",
                name: String(values.name),
                api_type: String(values.api_type),
                base_url: String(values.base_url),
                api_key_set: Boolean(values.api_key),
                enabled: Boolean(values.enabled),
                extra_body: values.extra_body as ProviderConfig["extra_body"],
              },
            ],
          };
        else
          saved = {
            ...saved,
            providers: saved.providers.map((provider) =>
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
      if (action === "save_model") {
        if (id === null)
          saved = {
            ...saved,
            models: [
              ...saved.models,
              {
                id: `m${saved.models.length + 1}`,
                provider_id: String(values.provider_id),
                model: String(values.model),
                name: String(values.name),
                enabled: Boolean(values.enabled),
                thinking_budget_tokens: values.thinking_budget_tokens as
                  | number
                  | null,
                thinking_options: ["default", "high"],
              },
            ],
          };
        else
          saved = {
            ...saved,
            models: saved.models.map((model) =>
              model.id === id ? { ...model, ...values } : model,
            ),
          };
      }
      if (action === "set_defaults")
        saved = {
          ...saved,
          default_model_id: values.model_id as string | null,
          default_thinking: values.thinking as ModelCatalog["default_thinking"],
        };
      if (action === "delete_provider")
        saved = {
          ...saved,
          providers: saved.providers.filter((provider) => provider.id !== id),
        };
      if (action === "delete_model")
        saved = {
          ...saved,
          models: saved.models.filter((model) => model.id !== id),
        };
      return saved;
    },
  );
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

function Navigation() {
  const router = useRouter();
  navigate = router.navigate;
  return <p>Current route: {router.route.name}</p>;
}
function mount() {
  return render(
    <StrictMode>
      <RouterProvider>
        <TooltipProvider>
          <Navigation />
          <ModelPanel />
        </TooltipProvider>
      </RouterProvider>
    </StrictMode>,
  );
}
function button(name: string) {
  return screen.getByRole("button", { name });
}
function change(name: string, value: string) {
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
}
function value(name: string) {
  return (screen.getByLabelText(name) as HTMLInputElement).value;
}
async function choose() {
  fireEvent.click(
    await screen.findByRole("button", { name: /^Example.*openai-chat/ }),
  );
  await screen.findByLabelText("API address");
}
async function open() {
  mount();
  await choose();
}
async function edit() {
  fireEvent.click(button("Edit provider"));
  await screen.findByLabelText("Provider name");
}
async function model(newModel = false) {
  fireEvent.click(button(newModel ? "Add model" : "Edit"));
  await screen.findByLabelText("Display name");
}
async function emit(event: BackendEvent) {
  await act(async () => {
    for (const listener of Array.from(listeners)) listener(event);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Provider configuration", () => {
  it("loads only a real catalog and recovers from read failure", async () => {
    vi.mocked(backend.modelCatalog).mockRejectedValue(
      new BackendError("timeout", "Catalog unavailable", true),
    );
    mount();
    await screen.findByText("Catalog unavailable");
    expect(screen.queryByLabelText("API address")).toBeNull();
    vi.mocked(backend.modelCatalog).mockResolvedValue(saved);
    fireEvent.click(button("Retry"));
    await screen.findByRole("button", { name: "Add" });
    expect(backend.configureModel).not.toHaveBeenCalled();
  });
  it("searches by name and protocol without changing the selected draft", async () => {
    await open();
    change("API address", "https://draft.test");
    change("Search providers", "google");
    expect(
      screen.queryByRole("button", { name: /^Example.*openai-chat/ }),
    ).toBeNull();
    expect(value("API address")).toBe("https://draft.test");
    change("Search providers", "missing");
    expect(screen.getByText("No providers found")).toBeTruthy();
  });
  it.each(["OpenAI Chat", "OpenAI Responses", "Anthropic", "Google"])(
    "creates a provider using %s",
    async (protocol) => {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Add" }));
      change("Provider name", "New provider");
      fireEvent.click(screen.getByRole("radio", { name: protocol }));
      fireEvent.click(button("Save"));
      await waitFor(() =>
        expect(backend.configureModel).toHaveBeenCalledWith(
          "save_provider",
          null,
          expect.objectContaining({ name: "New provider", extra_body: {} }),
        ),
      );
      expect(
        vi.mocked(backend.configureModel).mock.calls[0][2],
      ).not.toHaveProperty("clear_key");
      await waitFor(() =>
        expect(screen.queryByLabelText("Provider name")).toBeNull(),
      );
    },
  );
  it.each(["Cancel", "Close"])(
    "confirms a new provider %s once and preserves inputs when editing continues",
    async (action) => {
      mount();
      const add = await screen.findByRole("button", { name: "Add" });
      change("Thinking effort", "high");
      fireEvent.click(add);
      const dialog = await screen.findByRole("dialog", {
        name: "Add provider",
      });
      change("Provider name", "Provider draft");
      fireEvent.click(screen.getByRole("radio", { name: "Anthropic" }));
      change("API address", "https://draft.test/v1");
      change("API key", "fixture-key");
      const name = within(dialog).getByLabelText("Provider name");
      act(() => name.focus());
      fireEvent.click(within(dialog).getByRole("button", { name: action }));
      const confirmation = await screen.findByRole("dialog", {
        name: "Discard unsaved changes?",
      });
      expect(value("Provider name")).toBe("Provider draft");
      expect(value("API address")).toBe("https://draft.test/v1");
      expect(value("API key")).toBe("fixture-key");
      fireEvent.click(
        within(confirmation).getByRole("button", { name: "Keep Editing" }),
      );
      await waitFor(() => expect(document.activeElement).toBe(name));
      expect(value("Provider name")).toBe("Provider draft");
      expect(value("API address")).toBe("https://draft.test/v1");
      expect(value("API key")).toBe("fixture-key");
      expect(
        screen
          .getByRole("radio", { name: "Anthropic" })
          .getAttribute("aria-checked"),
      ).toBe("true");
      fireEvent.click(within(dialog).getByRole("button", { name: action }));
      fireEvent.click(button("Discard"));
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Add provider" }),
        ).toBeNull();
        expect(
          screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
        ).toBeNull();
        expect(document.activeElement).toBe(add);
      });
      expect(screen.getByText("Select a provider")).toBeTruthy();
      expect(value("Thinking effort")).toBe("high");
      const before = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(before);
      expect(before.defaultPrevented).toBe(true);
      expect(backend.configureModel).not.toHaveBeenCalled();
    },
  );
  it("shares one connection draft with the edit dialog and cancels through confirmation", async () => {
    await open();
    change("API address", "https://draft.test");
    await edit();
    expect(value("API address")).toBe("https://draft.test");
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Keep Editing"));
    expect(value("API address")).toBe("https://draft.test");
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Discard"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Provider name")).toBeNull(),
    );
    expect(value("API address")).toBe("https://example.test/v1");
  });
  it("saves only changed provider fields and updates the saved baseline", async () => {
    await open();
    const form = screen
      .getByLabelText("API address")
      .closest("form") as HTMLFormElement;
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(backend.configureModel).not.toHaveBeenCalled();
    change("API address", "https://draft.test");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
    change("API address", "https://example.test/v1");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    change("API address", "https://changed.test");
    fireEvent.click(button("Save"));
    await waitFor(() => {
      expect(saved.providers[0].base_url).toBe("https://changed.test");
      expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.submit(form);
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Example" }));
    await waitFor(() => {
      expect(saved.providers[0].enabled).toBe(false);
      expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    });
    expect(backend.configureModel).toHaveBeenCalledTimes(2);
  });
  it("saves only changed global defaults and retains failed changes for retry", async () => {
    await open();
    const form = button("Save defaults").closest("form") as HTMLFormElement;
    expect((button("Save defaults") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(backend.configureModel).not.toHaveBeenCalled();
    change("Thinking effort", "high");
    expect((button("Save defaults") as HTMLButtonElement).disabled).toBe(false);
    change("Thinking effort", "default");
    expect((button("Save defaults") as HTMLButtonElement).disabled).toBe(true);
    change("Thinking effort", "high");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("model_unavailable", "Default unavailable"),
    );
    fireEvent.click(button("Save defaults"));
    await screen.findByText("Default unavailable");
    await waitFor(() =>
      expect((button("Save defaults") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(value("Thinking effort")).toBe("high");
    fireEvent.click(button("Save defaults"));
    await waitFor(() => {
      expect(saved.default_thinking).toBe("high");
      expect((button("Save defaults") as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    fireEvent.submit(form);
    expect(backend.configureModel).toHaveBeenCalledTimes(2);
  });
  it("saves only changed model fields and keeps the provider draft independent", async () => {
    await open();
    change("API address", "https://draft.test");
    await model();
    const form = screen
      .getByLabelText("Display name")
      .closest("form") as HTMLFormElement;
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(backend.configureModel).not.toHaveBeenCalled();
    change("Display name", "Changed model");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
    change("Display name", "Example model");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button("Save"));
    await waitFor(() => {
      expect(saved.models[0].enabled).toBe(false);
      expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.submit(form);
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
    fireEvent.click(button("Cancel"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit model" })).toBeNull(),
    );
    expect(value("API address")).toBe("https://draft.test");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
  });
  it("preserves a blank stored key and supports explicit clearing", async () => {
    await open();
    expect(value("API key")).toBe("");
    change("API address", "https://changed.test/v1");
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        "p1",
        expect.objectContaining({
          api_key: "",
          clear_key: false,
          extra_body: { seed: 2 },
        }),
      ),
    );
    fireEvent.click(screen.getByLabelText("Clear stored key"));
    fireEvent.click(button("Save"));
    await waitFor(() => expect(saved.providers[0].api_key_set).toBe(false));
    expect(screen.queryByText("Key stored")).toBeNull();
  });
  it("shows only the entered key when visibility changes", async () => {
    await open();
    change("API key", "fixture-key");
    fireEvent.click(button("Show API key"));
    expect(screen.getByLabelText("API key").getAttribute("type")).toBe("text");
    expect(value("API key")).toBe("fixture-key");
  });
  it("keeps Provider, Model, Default and Enabled saves independent", async () => {
    await open();
    const address = screen.getByLabelText("API address");
    change("API address", "https://draft.test");
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Example" }));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        "p1",
        { enabled: false },
      ),
    );
    expect(value("API address")).toBe("https://draft.test");
    await model();
    change("Display name", "Model draft");
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_model",
        "m1",
        expect.objectContaining({ name: "Model draft" }),
      ),
    );
    expect((address as HTMLInputElement).value).toBe("https://draft.test");
  });
  it("submits model Enabled without saving connection drafts", async () => {
    await open();
    change("API address", "https://draft.test");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Enable model Example model" }),
    );
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith("save_model", "m1", {
        enabled: false,
      }),
    );
    expect(value("API address")).toBe("https://draft.test");
  });
  it("saves global defaults separately and keeps them through provider selection", async () => {
    await open();
    change("Thinking effort", "high");
    fireEvent.click(screen.getByRole("button", { name: /^Second.*google/ }));
    expect(value("Thinking effort")).toBe("high");
    fireEvent.click(button("Save defaults"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "set_defaults",
        null,
        { model_id: null, thinking: "high" },
      ),
    );
  });
  it("reads the directory from the saved provider and adds each model once", async () => {
    await open();
    fireEvent.click(button("Get model list"));
    await screen.findByText("new-remote");
    expect(backend.call).toHaveBeenCalledWith("settings.list_models", {
      provider_id: "p1",
    });
    fireEvent.click(button("Add"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_model",
        null,
        expect.objectContaining({ provider_id: "p1", model: "new-remote" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Added" }).length).toBe(2),
    );
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });
  it("shows an addition failure in the directory and retries only on an explicit Add", async () => {
    await open();
    fireEvent.click(button("Get model list"));
    const dialog = await screen.findByRole("dialog", { name: "Model list" });
    await within(dialog).findByText("new-remote");
    change("Search models", "remote");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("model_unavailable", "Model addition rejected"),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "Model addition rejected",
    );
    await waitFor(() =>
      expect(
        (
          within(dialog).getByRole("button", {
            name: "Add",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(value("Search models")).toBe("remote");
    expect(within(dialog).getByText("new-remote")).toBeTruthy();
    expect(within(dialog).getByText("remote-model")).toBeTruthy();
    expect(
      within(dialog).getAllByRole("button", { name: "Added" }),
    ).toHaveLength(1);
    expect(saved.models).toHaveLength(1);
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
    expect(backend.reportFailure).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(
        within(dialog).getAllByRole("button", { name: "Added" }),
      ).toHaveLength(2),
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(value("Search models")).toBe("remote");
    expect(backend.configureModel).toHaveBeenCalledTimes(2);
    expect(
      saved.models.filter((item) => item.model === "new-remote"),
    ).toHaveLength(1);
  });
  it("retains directory results when an explicit retry fails", async () => {
    await open();
    fireEvent.click(button("Get model list"));
    await screen.findByText("new-remote");
    vi.mocked(backend.call).mockRejectedValueOnce(
      new BackendError("model_listing", "Directory unavailable"),
    );
    fireEvent.click(button("Retry"));
    await screen.findByText("Directory unavailable");
    expect(screen.getByText("new-remote")).toBeTruthy();
  });
  it("requires an explicit saved model for Provider Test", async () => {
    await open();
    fireEvent.click(button("Test"));
    expect(backend.call).not.toHaveBeenCalled();
    expect((button("Test") as HTMLButtonElement).disabled).toBe(true);
    change("Saved model", "m1");
    change("Test thinking effort", "high");
    fireEvent.click(button("Test"));
    await screen.findByText("12 ms · OK");
    expect(backend.call).toHaveBeenCalledWith("settings.test_model", {
      model_id: "m1",
      thinking: "high",
    });
    expect(backend.configureModel).not.toHaveBeenCalled();
  });
  it("prompts for a model when the provider has none", async () => {
    saved.models = [];
    await open();
    fireEvent.click(button("Test"));
    expect(
      screen.getByText("Add a model before testing this provider."),
    ).toBeTruthy();
    expect(backend.call).not.toHaveBeenCalled();
  });
  it("tests an existing model using its ID and blocks unsaved remote fields", async () => {
    await open();
    await model();
    change("Test thinking effort", "high");
    fireEvent.click(button("Test"));
    await screen.findByText("12 ms · OK");
    expect(backend.call).toHaveBeenCalledWith("settings.test_model", {
      model_id: "m1",
      thinking: "high",
    });
    change("Model ID", "changed-remote");
    expect((button("Test") as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(["anthropic", "google"])(
    "tests a new model budget using saved %s connection",
    async (apiType) => {
      saved.providers[0].api_type = apiType;
      saved.providers[0].extra_body = {};
      mount();
      fireEvent.click(
        await screen.findByRole("button", {
          name: new RegExp(`^Example.*${apiType}`),
        }),
      );
      await model(true);
      change("Model ID", "new-remote");
      change("Thinking token budget", "2048");
      change("Test thinking effort", "budget");
      fireEvent.click(button("Test"));
      await screen.findByText("12 ms · OK");
      expect(backend.call).toHaveBeenCalledWith("settings.test_model", {
        provider_id: "p1",
        model: "new-remote",
        thinking: "budget",
        thinking_budget_tokens: 2048,
      });
      expect(backend.configureModel).not.toHaveBeenCalled();
    },
  );
  it("ignores delayed test results after input changes", async () => {
    await open();
    await model(true);
    const pending = deferred<{ latency_ms: number; reply: string }>();
    vi.mocked(backend.call).mockImplementationOnce(() => pending.promise);
    change("Model ID", "first");
    fireEvent.click(button("Test"));
    change("Model ID", "second");
    await act(async () =>
      pending.resolve({ latency_ms: 17, reply: "Old result" }),
    );
    expect(screen.queryByText("17 ms · Old result")).toBeNull();
  });
  it("reports test failures without losing model drafts", async () => {
    await open();
    await model();
    change("Display name", "Draft name");
    vi.mocked(backend.call).mockRejectedValueOnce(
      new BackendError("model_test", "Request rejected"),
    );
    fireEvent.click(button("Test"));
    await screen.findByText("Request rejected");
    expect(value("Display name")).toBe("Draft name");
  });
  it("preserves extra_body in the shared draft and blocks Test until saved", async () => {
    await open();
    fireEvent.click(button("Advanced settings"));
    expect(value("Custom request body")).toBe('{"seed":2}');
    change("Custom request body", '{"seed":3}');
    expect((button("Test") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Get model list") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        "p1",
        expect.objectContaining({ extra_body: { seed: 3 } }),
      ),
    );
    await waitFor(() =>
      expect((button("Test") as HTMLButtonElement).disabled).toBe(false),
    );
  });
  it.each(["[]", "null", '{"bad":'])(
    "rejects request body %s without submitting",
    async (body) => {
      await open();
      fireEvent.click(button("Advanced settings"));
      change("Custom request body", body);
      fireEvent.click(button("Save"));
      expect(backend.configureModel).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByLabelText("Custom request body"),
        ),
      );
    },
  );
  it("keeps request body errors associated with the field and restores focus", async () => {
    await open();
    fireEvent.click(button("Advanced settings"));
    change("Custom request body", '{"seed":3}');
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("invalid_request_body", "Body invalid"),
    );
    fireEvent.click(button("Save"));
    await screen.findAllByText("Body invalid");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Custom request body"),
      ),
    );
    expect(value("Custom request body")).toBe('{"seed":3}');
  });
  it("rejects a nonempty Google request body while retaining the draft", async () => {
    await open();
    await edit();
    fireEvent.click(screen.getByRole("radio", { name: "Google" }));
    fireEvent.click(button("Save"));
    expect(backend.configureModel).not.toHaveBeenCalled();
    expect(value("Custom request body")).toBe('{"seed":2}');
  });
  it("validates whitespace provider names locally", async () => {
    await open();
    await edit();
    change("Provider name", "   ");
    fireEvent.click(button("Save"));
    expect(
      screen.getByLabelText("Provider name").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(backend.configureModel).not.toHaveBeenCalled();
  });
  it("retains input through business errors", async () => {
    await open();
    change("API address", "https://draft.test");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("provider_in_use", "Provider in use"),
    );
    fireEvent.click(button("Save"));
    await screen.findByText("Provider in use");
    expect(value("API address")).toBe("https://draft.test");
  });
  it("requires confirmation and applies provider deletion only when models are absent", async () => {
    saved.models = [];
    await open();
    fireEvent.click(button("Delete"));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete Example?",
    });
    expect(backend.configureModel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "delete_provider",
        "p1",
        {},
      ),
    );
  });
  it("retains model drafts when a referenced model cannot be deleted", async () => {
    await open();
    await model();
    change("Display name", "Model draft");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("model_in_use", "Model in use"),
    );
    fireEvent.click(button("Delete model"));
    fireEvent.click(button("Delete"));
    await within(
      await screen.findByRole("dialog", { name: "Edit model" }),
    ).findByText("Model in use");
    expect(value("Display name")).toBe("Model draft");
  });
  it("protects navigation, latest destination and browser leave while dirty", async () => {
    await open();
    change("API address", "https://draft.test");
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    await act(async () => navigate({ name: "members" }));
    fireEvent.click(button("Keep Editing"));
    expect(value("API address")).toBe("https://draft.test");
    await act(async () => navigate({ name: "settings", section: "execution" }));
    await act(async () => navigate({ name: "members" }));
    fireEvent.click(button("Discard"));
    expect(screen.getByText("Current route: members")).toBeTruthy();
  });
  it("cleans browser protection and subscriptions on unmount", async () => {
    const view = mount();
    await choose();
    change("API address", "https://draft.test");
    view.unmount();
    expect(listeners.size).toBe(0);
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
  it("retains a deleted provider identity and refuses creating a replacement", async () => {
    await open();
    change("API address", "https://draft.test");
    saved = { ...saved, providers: saved.providers.slice(1) };
    await emit({ type: "settings.updated", section: "model" });
    expect(value("API address")).toBe("https://draft.test");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(
      screen.getByLabelText("API address").closest("form") as HTMLFormElement,
    );
    expect(backend.configureModel).not.toHaveBeenCalled();
  });
  it("retains deleted model identity and invalidates its pending test", async () => {
    await open();
    await model();
    change("Display name", "Retained draft");
    const pending = deferred<{ latency_ms: number; reply: string }>();
    vi.mocked(backend.call).mockImplementationOnce(() => pending.promise);
    fireEvent.click(button("Test"));
    saved = { ...saved, models: [] };
    await emit({ type: "settings.updated", section: "model" });
    expect(value("Display name")).toBe("Retained draft");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      pending.resolve({ latency_ms: 17, reply: "Deleted result" }),
    );
    expect(screen.queryByText("17 ms · Deleted result")).toBeNull();
  });
  it("retains new model drafts when their saved provider disappears", async () => {
    await open();
    await model(true);
    change("Display name", "New model draft");
    change("Model ID", "new-remote");
    saved = { ...saved, providers: saved.providers.slice(1) };
    await emit({ type: "settings.updated", section: "model" });
    expect(value("Display name")).toBe("New model draft");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
  });
  it("reads unknown write results before allowing a new attempt", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    change("Provider name", "Maybe saved");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("connection_lost", "Unknown save", true),
    );
    fireEvent.click(button("Save"));
    await within(
      screen.getByRole("dialog", { name: "Add provider" }),
    ).findByText(
      "The save result is unknown. Read the saved configuration before continuing.",
    );
    await emit({ type: "connection.restored" });
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
    expect(value("Provider name")).toBe("Maybe saved");
  });
  it("does not repeat pending writes or allow navigation during saving", async () => {
    await open();
    const pending = deferred<ModelCatalog>();
    vi.mocked(backend.configureModel).mockImplementationOnce(
      () => pending.promise,
    );
    change("API address", "https://draft.test");
    const form = screen
      .getByLabelText("API address")
      .closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await act(async () => navigate({ name: "members" }));
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    await act(async () => pending.resolve(saved));
  });
  it("coalesces continuous notifications while publishing current successful reads", async () => {
    await open();
    const pending: ReturnType<typeof deferred<ModelCatalog>>[] = [];
    vi.mocked(backend.modelCatalog).mockImplementation(() => {
      const read = deferred<ModelCatalog>();
      pending.push(read);
      return read.promise;
    });
    await emit({ type: "settings.updated", section: "model" });
    for (let i = 0; i < 3; i += 1) {
      for (let n = 0; n < 4; n += 1)
        await emit({ type: "settings.updated", section: "model" });
      await act(async () =>
        pending[i].resolve({
          ...saved,
          providers: [
            { ...saved.providers[0], name: `Published ${i}` },
            saved.providers[1],
          ],
        }),
      );
      expect(screen.getAllByText(`Published ${i}`).length).toBeGreaterThan(0);
      expect(pending.length).toBe(i + 2);
    }
    await act(async () => pending[3].resolve(saved));
  });
  it("ignores pre-save reads and consumes a pending refresh only after saving", async () => {
    await open();
    const prior = saved;
    const read = deferred<ModelCatalog>();
    vi.mocked(backend.modelCatalog).mockImplementationOnce(() => read.promise);
    await emit({ type: "settings.updated", section: "model" });
    change("API address", "https://saved.test");
    fireEvent.click(button("Save"));
    await waitFor(() =>
      expect(saved.providers[0].base_url).toBe("https://saved.test"),
    );
    await act(async () => read.resolve(prior));
    expect(value("API address")).toBe("https://saved.test");
  });
  it("ignores a catalog response after connection closure and reads on restoration", async () => {
    await open();
    change("API address", "https://draft.test");
    const read = deferred<ModelCatalog>();
    vi.mocked(backend.modelCatalog).mockImplementationOnce(() => read.promise);
    await emit({ type: "settings.updated", section: "model" });
    await emit({ type: "connection.reconnecting" });
    await act(async () =>
      read.resolve({
        ...saved,
        providers: [{ ...saved.providers[0], name: "Expired provider" }],
      }),
    );
    expect(screen.queryByText("Expired provider")).toBeNull();
    expect(
      screen.getByLabelText("API address").closest("fieldset")?.disabled,
    ).toBe(true);
    const calls = vi.mocked(backend.modelCatalog).mock.calls.length;
    await emit({ type: "settings.updated", section: "model" });
    expect(backend.modelCatalog).toHaveBeenCalledTimes(calls);
    await emit({ type: "connection.restored" });
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
  });
  it("requires catalog confirmation when a pending save crosses a connection", async () => {
    await open();
    const write = deferred<ModelCatalog>();
    const read = deferred<ModelCatalog>();
    vi.mocked(backend.configureModel).mockImplementationOnce(
      () => write.promise,
    );
    change("API address", "https://draft.test");
    fireEvent.click(button("Save"));
    await emit({ type: "connection.reconnecting" });
    vi.mocked(backend.modelCatalog).mockImplementationOnce(() => read.promise);
    await emit({ type: "connection.restored" });
    await act(async () =>
      write.resolve({
        ...saved,
        providers: [{ ...saved.providers[0], name: "Expired save" }],
      }),
    );
    expect(screen.queryByText("Expired save")).toBeNull();
    expect(value("API address")).toBe("https://draft.test");
    expect(
      screen.queryByRole("button", { name: "Use saved configuration" }),
    ).toBeNull();
    await act(async () => read.resolve(saved));
    fireEvent.click(button("Use saved configuration"));
    await choose();
    expect(value("API address")).toBe("https://example.test/v1");
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });
  it("invalidates closed directory requests and accepts only the reopened result", async () => {
    await open();
    const old = deferred<{ models: string[] }>();
    vi.mocked(backend.call).mockImplementationOnce(() => old.promise);
    fireEvent.click(button("Get model list"));
    const dialog = await screen.findByRole("dialog", { name: "Model list" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Model list" })).toBeNull(),
    );
    fireEvent.click(button("Get model list"));
    await screen.findByText("new-remote");
    await act(async () => old.resolve({ models: ["expired-model"] }));
    expect(screen.queryByText("expired-model")).toBeNull();
    expect(screen.getByText("new-remote")).toBeTruthy();
  });
  it("invalidates directory and model tests when the connection closes", async () => {
    await open();
    const old = deferred<{ models: string[] }>();
    vi.mocked(backend.call).mockImplementationOnce(() => old.promise);
    fireEvent.click(button("Get model list"));
    await emit({ type: "connection.reconnecting" });
    await act(async () => old.resolve({ models: ["expired-model"] }));
    expect(screen.queryByText("expired-model")).toBeNull();
    expect((button("Retry") as HTMLButtonElement).disabled).toBe(true);
    await emit({ type: "connection.restored" });
    await screen.findByText("new-remote");
    fireEvent.click(button("Close"));
    await model();
    const test = deferred<{ latency_ms: number; reply: string }>();
    vi.mocked(backend.call).mockImplementationOnce(() => test.promise);
    fireEvent.click(button("Test"));
    await emit({ type: "connection.reconnecting" });
    await act(async () =>
      test.resolve({ latency_ms: 17, reply: "Expired test" }),
    );
    expect(screen.queryByText("17 ms · Expired test")).toBeNull();
  });
  it("does not duplicate a pending directory read or model test", async () => {
    await open();
    const read = deferred<{ models: string[] }>();
    vi.mocked(backend.call).mockImplementationOnce(() => read.promise);
    fireEvent.click(button("Get model list"));
    fireEvent.click(button("Retry"));
    fireEvent.click(button("Retry"));
    expect(backend.call).toHaveBeenCalledTimes(1);
    await act(async () => read.resolve({ models: ["new-remote"] }));
    fireEvent.click(button("Close"));
    await model();
    const test = deferred<{ latency_ms: number; reply: string }>();
    vi.mocked(backend.call).mockImplementationOnce(() => test.promise);
    const trigger = button("Test");
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(backend.call).toHaveBeenCalledTimes(2);
    await act(async () => test.resolve({ latency_ms: 17, reply: "OK" }));
  });
  it("confirms unknown directory additions from saved objects before continuing", async () => {
    saved.models = [];
    await open();
    fireEvent.click(button("Get model list"));
    const dialog = await screen.findByRole("dialog", { name: "Model list" });
    await within(dialog).findByText("new-remote");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("connection_lost", "Unknown addition", true),
    );
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Add" })[1]);
    await within(dialog).findByText(
      "The save result is unknown. Read the saved configuration before continuing.",
    );
    saved = {
      ...saved,
      models: [
        {
          id: "confirmed-model",
          provider_id: "p1",
          name: "new-remote",
          model: "new-remote",
          enabled: true,
          thinking_budget_tokens: null,
          thinking_options: ["default"],
        },
      ],
    };
    await emit({ type: "connection.restored" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use saved configuration" }),
    );
    await choose();
    expect(screen.getAllByText("new-remote").length).toBeGreaterThan(0);
    fireEvent.click(button("Get model list"));
    await screen.findByRole("button", { name: "Added" });
    expect(backend.configureModel).toHaveBeenCalledTimes(1);
  });
  it("restores Provider and Model Enabled after rejected writes while retaining drafts", async () => {
    await open();
    change("API address", "https://draft.test");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("model_in_use", "Enabled rejected"),
    );
    fireEvent.click(screen.getByLabelText("Enable Example"));
    await screen.findByText("Enabled rejected");
    expect(
      (screen.getByLabelText("Enable Example") as HTMLInputElement).checked,
    ).toBe(true);
    expect(value("API address")).toBe("https://draft.test");
    vi.mocked(backend.configureModel).mockRejectedValueOnce(
      new BackendError("model_in_use", "Model enabled rejected"),
    );
    fireEvent.click(screen.getByLabelText("Enable model Example model"));
    await screen.findByText("Model enabled rejected");
    expect(
      (screen.getByLabelText("Enable model Example model") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(value("API address")).toBe("https://draft.test");
  });
  it("retains model drafts on Cancel and updates the baseline after Save", async () => {
    await open();
    await model();
    change("Display name", "Edited model");
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Keep Editing"));
    expect(value("Display name")).toBe("Edited model");
    fireEvent.click(button("Save"));
    await waitFor(() => {
      expect(saved.models[0].name).toBe("Edited model");
      const before = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(before);
      expect(before.defaultPrevented).toBe(false);
    });
    fireEvent.click(button("Cancel"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit model" })).toBeNull(),
    );
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    await model();
    expect(value("Display name")).toBe("Edited model");
  });
  it("disables the shared Provider dialog fields during a pending save", async () => {
    await open();
    await edit();
    const pending = deferred<ModelCatalog>();
    vi.mocked(backend.configureModel).mockImplementationOnce(
      () => pending.promise,
    );
    change("API address", "https://draft.test");
    fireEvent.click(button("Save"));
    expect(
      screen.getByLabelText("API address").closest("fieldset")?.disabled,
    ).toBe(true);
    fireEvent.click(button("Cancel"));
    expect(screen.getByRole("dialog", { name: "Edit provider" })).toBeTruthy();
    await act(async () => pending.resolve(saved));
  });
  it("submits only the focused Provider or Model form with Enter", async () => {
    await open();
    const user = userEvent.setup({ document });
    change("API address", "https://draft.test");
    await user.click(screen.getByLabelText("API address"));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_provider",
        "p1",
        expect.objectContaining({ base_url: "https://draft.test" }),
      ),
    );
    await waitFor(() =>
      expect((button("Save") as HTMLButtonElement).disabled).toBe(true),
    );
    await model();
    change("Display name", "Model entered");
    await user.click(screen.getByLabelText("Display name"));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(backend.configureModel).toHaveBeenCalledWith(
        "save_model",
        "m1",
        expect.objectContaining({ name: "Model entered" }),
      ),
    );
    expect(backend.configureModel).toHaveBeenCalledTimes(2);
  });
  it.each(["openai-chat", "openai-responses", "anthropic", "google"])(
    "edits saved connection fields for %s",
    async (apiType) => {
      saved.providers[0].api_type = apiType;
      saved.providers[0].extra_body = {};
      mount();
      fireEvent.click(
        await screen.findByRole("button", {
          name: new RegExp(`^Example.*${apiType}`),
        }),
      );
      await edit();
      change("Provider name", "Renamed provider");
      change("API address", "https://changed.test");
      change("API key", "test-only-replacement");
      fireEvent.click(button("Save"));
      await waitFor(() =>
        expect(backend.configureModel).toHaveBeenCalledWith(
          "save_provider",
          "p1",
          expect.objectContaining({
            name: "Renamed provider",
            api_type: apiType,
            base_url: "https://changed.test",
            api_key: "test-only-replacement",
            clear_key: false,
            extra_body: {},
          }),
        ),
      );
    },
  );
  it("normalizes a saved model budget and ends unsaved protection", async () => {
    saved.providers[0].api_type = "anthropic";
    saved.providers[0].extra_body = {};
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Example.*anthropic/ }),
    );
    await model();
    change("Thinking token budget", "02048");
    fireEvent.click(button("Save"));
    await waitFor(() => {
      expect(value("Thinking token budget")).toBe("2048");
      expect(saved.models[0].thinking_budget_tokens).toBe(2048);
      const before = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(before);
      expect(before.defaultPrevented).toBe(false);
    });
    fireEvent.click(button("Cancel"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit model" })).toBeNull(),
    );
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
  });
  it("keeps drafts through connection restoration", async () => {
    await open();
    change("API address", "https://draft.test");
    await emit({ type: "connection.restored" });
    expect(value("API address")).toBe("https://draft.test");
  });
});
