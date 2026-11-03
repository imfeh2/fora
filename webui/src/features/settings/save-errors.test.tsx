import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { ModelPanel } from "@/features/settings/model";
import {
  BackendError,
  backend,
  type ModelCatalog,
  type ProviderConfig,
  type RegisteredModel,
} from "@/lib/backend";

const provider: ProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  api_type: "openai-chat",
  base_url: "https://api.deepseek.com",
  api_key: "sk-test",
  api_key_set: true,
  enabled: true,
};

function model(id: string, name: string, ref: string): RegisteredModel {
  return {
    id,
    provider_id: "deepseek",
    name,
    model: ref,
    thinking_budget_tokens: null,
    thinking_options: [],
  };
}

function catalogWith(models: RegisteredModel[]): ModelCatalog {
  return {
    version: 2,
    providers: [provider],
    models,
    default_model_id: models[0]?.id ?? null,
    default_thinking: "default",
    agent_configs: {},
  };
}

function renderPanel(view: "providers" | "models") {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <ModelPanel view={view} />
        <Toaster />
      </RouterProvider>
    </TooltipProvider>,
  );
}

async function openProvider(container: HTMLElement): Promise<void> {
  const row = await waitFor(() => {
    const target = container.querySelector<HTMLButtonElement>(
      "[data-provider-target]",
    );
    if (target === null) throw new Error("provider row is missing");
    return target;
  });
  fireEvent.click(row);
}

async function openModelEditor(container: HTMLElement): Promise<void> {
  await openProvider(container);
  fireEvent.click(await screen.findByRole("button", { name: "Edit model" }));
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

describe("settings save failures", () => {
  it("reports a refused provider save as a toast without an inline alert", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalogWith([]));
    vi.spyOn(backend, "configureModel").mockRejectedValue(
      new BackendError("provider_rejected", "The provider rejected the key"),
    );
    const { container } = renderPanel("providers");
    await openProvider(container);

    fireEvent.click(await screen.findByLabelText("Enable DeepSeek"));

    expect(await screen.findByText("Could not save the provider")).toBeTruthy();
    expect(screen.getByText("The provider rejected the key")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a refused provider delete as a toast", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalogWith([]));
    vi.spyOn(backend, "configureModel").mockRejectedValue(
      new BackendError("not_found", "Provider no longer exists"),
    );
    const { container } = renderPanel("providers");
    await waitFor(() =>
      expect(container.querySelector("[data-provider-target]")).not.toBeNull(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for DeepSeek" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete provider" }),
    );

    expect(
      await screen.findByText("Could not delete the provider"),
    ).toBeTruthy();
    expect(screen.getByText("Provider no longer exists")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a refused model save as a toast", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(
      catalogWith([model("m1", "Chat", "deepseek-chat")]),
    );
    vi.spyOn(backend, "configureModel").mockRejectedValue(
      new BackendError("invalid_model", "The model is not available"),
    );
    const { container } = renderPanel("providers");
    await openModelEditor(container);

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Chat 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Could not save the model")).toBeTruthy();
    expect(screen.getByText("The model is not available")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a refused model delete as a toast", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(
      catalogWith([model("m1", "Chat", "deepseek-chat")]),
    );
    vi.spyOn(backend, "configureModel").mockRejectedValue(
      new BackendError("model_in_use", "A Member still uses this model"),
    );
    const { container } = renderPanel("providers");
    await openProvider(container);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete model" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete model" }),
    );

    expect(await screen.findByText("Could not delete the model")).toBeTruthy();
    expect(screen.getByText("A Member still uses this model")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a refused default save as a toast with the next step", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(
      catalogWith([
        model("m1", "Chat", "deepseek-chat"),
        model("m2", "Reasoner", "deepseek-reasoner"),
      ]),
    );
    vi.spyOn(backend, "configureModel").mockRejectedValue(
      new BackendError("provider_disabled", "That provider is disabled"),
    );
    const { container } = renderPanel("models");

    await waitFor(() => expect(screen.getByLabelText("Model")).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "m2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    expect(
      await screen.findByText("Could not save the global default"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "That provider is disabled. Enable that provider or model under Providers, or choose another default, then save again.",
      ),
    ).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a transport failure in the recovery panel instead of a toast", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalogWith([]));
    vi.spyOn(backend, "configureModel").mockRejectedValue(
      new BackendError("connection_closed", "The connection closed", true),
    );
    const { container } = renderPanel("providers");
    await openProvider(container);

    fireEvent.click(await screen.findByLabelText("Enable DeepSeek"));

    expect(await screen.findByText(/The save result is unknown/)).toBeTruthy();
    expect(screen.queryByText("Could not save the provider")).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
