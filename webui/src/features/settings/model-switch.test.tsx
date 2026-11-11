import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentCreateDialog, ModelPanel } from "@/features/settings/model";
import {
  backend,
  type ModelCatalog,
  type RegisteredModel,
} from "@/lib/backend";

function catalogWith(
  models: RegisteredModel[],
  enabled = true,
  apiKey = "sk-test-deepseek",
): ModelCatalog {
  return {
    version: 2,
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        api_type: "openai-chat",
        base_url: "https://api.deepseek.com",
        api_key: apiKey,
        api_key_set: apiKey !== "",
        enabled,
      },
    ],
    models,
    default_model_id: models[0]?.id ?? null,
    default_thinking: "default",
    agent_configs: {},
  };
}

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

function renderPanel() {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <ModelPanel view="providers" />
      </RouterProvider>
    </TooltipProvider>,
  );
}

function renderAgentDialog() {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <AgentCreateDialog onClose={() => {}} onCreated={async () => {}} />
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

async function modelsSection(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const section = container.querySelector<HTMLElement>(
      'section[aria-label="Models"]',
    );
    if (section === null) throw new Error("models section is missing");
    return section;
  }) as Promise<HTMLElement>;
}

async function agentModelGroup(enabled: boolean): Promise<HTMLOptGroupElement> {
  cleanup();
  renderAgentDialog();
  const select = (await screen.findByLabelText("Model")) as HTMLSelectElement;
  const option = within(select).getByRole("option", { name: "Chat" });
  const group = option.closest("optgroup");
  if (group === null) throw new Error("model is not grouped by provider");
  expect(group.disabled).toBe(!enabled);
  return group;
}

function stubBackend() {
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
  vi.spyOn(backend, "permissionCatalog").mockResolvedValue([]);
}

beforeAll(stubBackend);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  stubBackend();
});

describe("model settings without a per-model switch", () => {
  it("shows no switch on a model row or in the model editor", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(
      catalogWith([model("m1", "Chat", "deepseek-chat")]),
    );
    const { container } = renderPanel();
    await openProvider(container);
    const models = await modelsSection(container);

    expect(models.querySelector('[role="switch"]')).toBeNull();
    expect(models.querySelector('input[type="checkbox"]')).toBeNull();

    fireEvent.click(within(models).getByRole("button", { name: "Edit model" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).queryByLabelText(/Enable/)).toBeNull();
    expect(within(dialog).getByLabelText("Display name")).toBeTruthy();
  });

  it("adds a model without an enable field and offers it to new Agents", async () => {
    const catalog = catalogWith([]);
    const loading = vi
      .spyOn(backend, "modelCatalog")
      .mockResolvedValue(catalog);
    const configure = vi
      .spyOn(backend, "configureModel")
      .mockResolvedValue(catalogWith([model("m1", "Chat", "deepseek-chat")]));
    const { container } = renderPanel();
    await openProvider(container);
    await modelsSection(container);

    fireEvent.click(await screen.findByRole("button", { name: "Add model" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).queryByLabelText(/Enable/)).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Chat" },
    });
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Model ID" }),
      { target: { value: "deepseek-chat" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configure).toHaveBeenCalled());

    loading.mockResolvedValue(
      catalogWith([model("m1", "Chat", "deepseek-chat")]),
    );
    await agentModelGroup(true);
  });

  it("greys out the models of a disabled provider in the Agent model list", async () => {
    const loading = vi
      .spyOn(backend, "modelCatalog")
      .mockResolvedValue(
        catalogWith([model("m1", "Chat", "deepseek-chat")], false),
      );
    await agentModelGroup(false);

    loading.mockResolvedValue(
      catalogWith([model("m1", "Chat", "deepseek-chat")], true),
    );
    await agentModelGroup(true);
  });

  it("lists the providers and models stored with the old switch", async () => {
    const catalog = catalogWith([model("m1", "Chat", "deepseek-chat")]);
    const loading = vi
      .spyOn(backend, "modelCatalog")
      .mockResolvedValue(catalog);
    const { container } = renderPanel();
    await openProvider(container);
    const models = await modelsSection(container);

    expect(within(models).getByText("Chat")).toBeTruthy();
    expect(models.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).not.toContain("Disabled");

    loading.mockResolvedValue(catalog);
    await agentModelGroup(true);
  });

  it("clears the key when the field is emptied and keeps the next key", async () => {
    const loading = vi
      .spyOn(backend, "modelCatalog")
      .mockResolvedValue(catalogWith([]));
    const configure = vi
      .spyOn(backend, "configureModel")
      .mockResolvedValue(catalogWith([], true, ""));
    const first = renderPanel();
    await openProvider(first.container);
    const input = (await waitFor(() =>
      screen.getByLabelText("API key"),
    )) as HTMLInputElement;
    expect(input.value).toBe("sk-test-deepseek");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(configure).toHaveBeenCalled());

    cleanup();
    loading.mockResolvedValue(catalogWith([], true, ""));
    const second = renderPanel();
    await openProvider(second.container);
    const cleared = (await waitFor(() =>
      screen.getByLabelText("API key"),
    )) as HTMLInputElement;
    expect(cleared.value).toBe("");

    fireEvent.change(cleared, { target: { value: "sk-test-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));

    cleanup();
    loading.mockResolvedValue(catalogWith([], true, "sk-test-new"));
    const third = renderPanel();
    await openProvider(third.container);
    const replaced = (await waitFor(() =>
      screen.getByLabelText("API key"),
    )) as HTMLInputElement;
    expect(replaced.value).toBe("sk-test-new");
  });
});
