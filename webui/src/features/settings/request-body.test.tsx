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
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelPanel } from "@/features/settings/model";
import { parseRequestBody } from "@/features/settings/request-body";
import {
  BackendError,
  type BackendEvent,
  backend,
  type ModelCatalog,
} from "@/lib/backend";

let dom: { window: Window & { close: () => void } };
let testing: typeof import("@testing-library/react");
let events: (event: BackendEvent) => void;

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "MutationObserver",
    "Event",
    "EventTarget",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
  ])
    vi.stubGlobal(
      key,
      key === "window" ? dom.window : Reflect.get(dom.window, key),
    );
  dom.window.requestAnimationFrame = vi.fn();
  dom.window.cancelAnimationFrame = vi.fn();
  testing = await import("@testing-library/react");
});
afterEach(async () => {
  testing.cleanup();
  await testing.act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  vi.restoreAllMocks();
});
afterAll(async () => {
  await testing.act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  dom.window.close();
  vi.unstubAllGlobals();
});

const catalog: ModelCatalog = {
  version: 2,
  providers: [
    {
      id: "p",
      name: "Provider",
      api_type: "openai-chat",
      base_url: "https://provider.invalid",
      api_key_set: true,
      enabled: true,
      extra_body: { extension: 1 },
    },
  ],
  models: [
    {
      id: "m",
      provider_id: "p",
      name: "Model",
      model: "custom-model",
      enabled: true,
      thinking_budget_tokens: null,
      thinking_options: ["default", "high"],
    },
  ],
  default_model_id: "m",
  default_thinking: "high",
  agent_configs: {},
};

beforeEach(() => {
  vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalog);
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    events = listener;
    return () => {};
  });
});

async function mount() {
  testing.render(
    <TooltipProvider>
      <ModelPanel />
    </TooltipProvider>,
  );
  const select = await testing.screen.findByLabelText("Provider");
  testing.fireEvent.change(select, { target: { value: "p" } });
  return testing.screen.getByLabelText(
    "Custom request body",
  ) as HTMLTextAreaElement;
}

function save() {
  testing.fireEvent.submit(
    testing.screen
      .getByRole("button", { name: "Save provider" })
      .closest("form") as HTMLFormElement,
  );
}

describe("Custom request body validation", () => {
  it.each([
    "{",
    "null",
    "[]",
    "123",
    '{"9field":1}',
    '{"messages":[]}',
    '{"extension":{"apiKey":"test-marker"}}',
    '{"x":1e999}',
    '{"x":"\\ud800"}',
  ])("rejects invalid content %s", (text) => {
    expect(parseRequestBody(text, "openai-chat").error).not.toBeNull();
  });
  it("accepts Unicode, null and the exact size and depth limits", () => {
    expect(
      parseRequestBody('{"x":"你好😀","nullable":null}', "openai-chat").value,
    ).toEqual({ x: "你好😀", nullable: null });
    const text = JSON.stringify({ x: "a".repeat(16384 - 8) });
    expect(parseRequestBody(text, "openai-chat").error).toBeNull();
    expect(parseRequestBody(`${text} `, "openai-chat").error).toContain(
      "16 KiB",
    );
    let value: unknown = {};
    for (let i = 0; i < 15; i++) value = { x: value };
    expect(
      parseRequestBody(JSON.stringify(value), "openai-chat").error,
    ).toBeNull();
    expect(
      parseRequestBody(JSON.stringify({ x: value }), "openai-chat").error,
    ).toContain("16 container");
  });
});

describe("Provider request body form", () => {
  it.each([375, 640, 1280])(
    "keeps errors and field input at width %s",
    async (width) => {
      Object.defineProperty(dom.window, "innerWidth", {
        value: width,
        configurable: true,
      });
      const configure = vi
        .spyOn(backend, "configureModel")
        .mockResolvedValue(catalog);
      const input = await mount();
      input.focus();
      testing.fireEvent.change(input, { target: { value: "{" } });
      save();
      expect(testing.screen.getByRole("alert").textContent).toContain(
        "valid JSON",
      );
      expect(input.value).toBe("{");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toContain(
        testing.screen.getByRole("alert").id,
      );
      expect(document.activeElement).toBe(input);
      expect(configure).not.toHaveBeenCalled();
      expect(
        testing.screen.getByRole("button", {
          name: "About custom request body",
        }),
      ).toBeTruthy();
    },
  );
  it("replaces the object and reads back saved content", async () => {
    const updated = {
      ...catalog,
      providers: [{ ...catalog.providers[0], extra_body: { nullable: null } }],
    };
    const configure = vi
      .spyOn(backend, "configureModel")
      .mockResolvedValue(updated);
    const input = await mount();
    testing.fireEvent.change(input, {
      target: { value: ' {"nullable":null} ' },
    });
    save();
    await testing.waitFor(() => expect(input.value).toBe('{"nullable":null}'));
    expect(configure.mock.calls[0][2]).toMatchObject({
      extra_body: { nullable: null },
    });
  });
  it("preserves the input and API key draft after a server field error", async () => {
    vi.spyOn(backend, "configureModel").mockRejectedValue(
      new BackendError(
        "invalid_request_body",
        "Remove this field for the selected API.",
      ),
    );
    const input = await mount();
    const key = testing.screen.getByLabelText("API key") as HTMLInputElement;
    testing.fireEvent.change(key, { target: { value: "test-only-key" } });
    testing.fireEvent.change(input, { target: { value: '{"extension":2}' } });
    save();
    await testing.waitFor(() =>
      expect(testing.screen.getByRole("alert").textContent).toContain(
        "Remove this field",
      ),
    );
    expect(input.value).toBe('{"extension":2}');
    expect(key.value).toBe("test-only-key");
    expect(document.activeElement).toBe(input);
  });
  it("preserves dirty content on reconnect and requires clearing for Google", async () => {
    const configure = vi.spyOn(backend, "configureModel").mockResolvedValue({
      ...catalog,
      providers: [
        { ...catalog.providers[0], api_type: "google", extra_body: {} },
      ],
    });
    const input = await mount();
    testing.fireEvent.change(input, { target: { value: '{"extension":2}' } });
    await testing.act(async () => events({ type: "connection.restored" }));
    expect(input.value).toBe('{"extension":2}');
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Google" }),
    );
    save();
    expect(configure).not.toHaveBeenCalled();
    expect(testing.screen.getByRole("alert").textContent).toContain(
      "Clear it before saving",
    );
    testing.fireEvent.change(input, { target: { value: "" } });
    save();
    await testing.waitFor(() => expect(configure).toHaveBeenCalled());
    expect(configure.mock.calls[0][2]).toMatchObject({
      api_type: "google",
      extra_body: {},
    });
  });
  it("Tests a model through its saved provider identity", async () => {
    const call = vi
      .spyOn(backend, "call")
      .mockResolvedValue({ latency_ms: 5, reply: "OK" });
    await mount();
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: /Model\s*custom-model/ }),
    );
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Test" }),
    );
    await testing.waitFor(() =>
      expect(call).toHaveBeenCalledWith("settings.test_model", {
        model_id: "m",
        thinking: "default",
      }),
    );
  });
});
