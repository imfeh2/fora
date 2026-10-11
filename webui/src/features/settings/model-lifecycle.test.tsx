import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, readToasts } from "@/components/ui/toast";
import {
  AgentCreateDialog,
  AgentModelPanel,
  ModelPanel,
} from "@/features/settings/model";
import { useReportSettingsSave, useSaver } from "@/features/settings/saver";
import { type BackendEvent, backend, type ModelCatalog } from "@/lib/backend";

const lifecycle = vi.hoisted(() => ({
  effects: [] as (() => undefined | (() => void))[],
  setters: [] as ReturnType<typeof vi.fn>[],
  initial: new Map<number, unknown>(),
  context: null as {
    report: (section: string, saving: boolean) => void;
  } | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useContext: () => lifecycle.context,
  useState: (initial: unknown) => {
    const setter = vi.fn();
    const value = lifecycle.initial.get(lifecycle.setters.length) ?? initial;
    lifecycle.setters.push(setter);
    return [value, setter];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useId: () => "model-test",
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => undefined | (() => void)) => {
    lifecycle.effects.push(effect);
  },
}));

const catalog: ModelCatalog = {
  version: 2,
  providers: [
    {
      id: "provider-a",
      name: "Provider A",
      api_type: "openai-chat",
      base_url: "https://a.test",
      api_key_set: false,
      enabled: true,
    },
    {
      id: "provider-b",
      name: "Provider B",
      api_type: "openai-chat",
      base_url: "https://b.test",
      api_key_set: false,
      enabled: true,
    },
  ],
  models: [],
  default_model_id: null,
  default_thinking: "default",
  agent_configs: { "2": { model_id: null, thinking: "high" } },
};
let event: (value: BackendEvent) => void;
let cleanups: (() => void)[];
const off = vi.fn();

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  lifecycle.effects = [];
  lifecycle.setters = [];
  lifecycle.initial.clear();
  lifecycle.context = null;
  cleanups = [];
  off.mockClear();
  clearToasts();
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    event = listener;
    return off;
  });
  vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalog);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mountEffects() {
  for (const effect of lifecycle.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const updated: ModelCatalog = {
  ...catalog,
  default_thinking: "low",
  agent_configs: { "2": { model_id: null, thinking: "low" } },
};

function findNewModelForm(node: unknown): { key: string | null } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = findNewModelForm(child);
      if (result) return result;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const element = node as {
    type?: { name?: string };
    key?: string | null;
    props?: { children?: unknown; model?: unknown };
  };
  if (element.type?.name === "ModelForm" && !element.props?.model) {
    return { key: element.key ?? null };
  }
  return findNewModelForm(element.props?.children);
}

function newModelFormKey(providerId: string, expanded: boolean): string | null {
  lifecycle.setters = [];
  lifecycle.initial.clear();
  lifecycle.initial.set(0, catalog);
  lifecycle.initial.set(3, providerId);
  lifecycle.initial.set(4, expanded ? ["new"] : []);
  return findNewModelForm(ModelPanel())?.key ?? null;
}

function mountPanel(agent: boolean) {
  lifecycle.initial.set(0, catalog);
  if (agent) {
    const panel = AgentModelPanel({ agentId: 2 });
    return {
      save: () => panel.props.onSubmit({ preventDefault: vi.fn() }),
      edit: () => panel.props.onChangeCapture(),
    };
  }
  const panel = ModelPanel();
  const defaults = panel.props.children[1].props.children.props.children[0];
  return {
    save: () => defaults.props.save("set_defaults", null, {}),
    edit: () => {},
  };
}

describe.each([false, true])("model read ordering: Agent %s", (agent) => {
  it("keeps a successful save when an earlier read returns late", async () => {
    const earlier = deferred<ModelCatalog>();
    vi.mocked(backend.modelCatalog).mockReturnValueOnce(earlier.promise);
    vi.spyOn(backend, "configureModel").mockResolvedValue(updated);
    const panel = mountPanel(agent);
    await mountEffects();
    panel.edit();
    await panel.save();
    earlier.resolve(catalog);
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(updated);
    if (agent) {
      expect(lifecycle.setters[1]).toHaveBeenLastCalledWith(
        updated.agent_configs["2"],
      );
    }
    vi.mocked(backend.modelCatalog).mockResolvedValueOnce(catalog);
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(catalog);
    if (agent) {
      expect(lifecycle.setters[1]).toHaveBeenLastCalledWith(
        catalog.agent_configs["2"],
      );
    }
  });

  it("invalidates reads started during a save when the save succeeds", async () => {
    const saving = deferred<ModelCatalog>();
    const reading = deferred<ModelCatalog>();
    vi.spyOn(backend, "configureModel").mockReturnValueOnce(saving.promise);
    const panel = mountPanel(agent);
    await mountEffects();
    panel.edit();
    const saved = panel.save();
    vi.mocked(backend.modelCatalog).mockReturnValueOnce(reading.promise);
    event({ type: "connection.restored" });
    saving.resolve(updated);
    await saved;
    reading.resolve(catalog);
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(updated);
    if (agent) {
      expect(lifecycle.setters[1]).toHaveBeenLastCalledWith(
        updated.agent_configs["2"],
      );
    }
  });

  it("ignores a late read failure after saving successfully", async () => {
    const earlier = deferred<ModelCatalog>();
    vi.mocked(backend.modelCatalog).mockReturnValueOnce(earlier.promise);
    vi.spyOn(backend, "configureModel").mockResolvedValue(updated);
    const panel = mountPanel(agent);
    await mountEffects();
    await panel.save();
    earlier.reject(new Error("outdated read"));
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(updated);
    expect(readToasts().filter((item) => item.tone === "danger")).toEqual([]);
    if (!agent) expect(lifecycle.setters[2]).toHaveBeenLastCalledWith(false);
  });

  it("discards an unfinished read when leaving the panel", async () => {
    const pending = deferred<ModelCatalog>();
    vi.mocked(backend.modelCatalog).mockReturnValueOnce(pending.promise);
    mountPanel(agent);
    await mountEffects();
    cleanups.pop()?.();
    pending.resolve(catalog);
    await Promise.resolve();
    expect(lifecycle.setters[0]).not.toHaveBeenCalled();
  });

  it("keeps the latest reconnect response when an older read finishes last", async () => {
    const earlier = deferred<ModelCatalog>();
    vi.mocked(backend.modelCatalog).mockReturnValueOnce(earlier.promise);
    mountPanel(agent);
    await mountEffects();
    vi.mocked(backend.modelCatalog).mockResolvedValueOnce(updated);
    event({ type: "connection.restored" });
    await Promise.resolve();
    earlier.resolve(catalog);
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(updated);
    if (agent) {
      expect(lifecycle.setters[1]).toHaveBeenLastCalledWith(
        updated.agent_configs["2"],
      );
    }
  });
});

describe("new Model form identity", () => {
  it("resets the draft when switching providers and returning", () => {
    const providerA = newModelFormKey("provider-a", true);
    const providerB = newModelFormKey("provider-b", true);
    const returnedA = newModelFormKey("provider-a", true);

    expect(providerA).toBe("provider-a");
    expect(providerB).toBe("provider-b");
    expect(returnedA).toBe(providerA);
  });

  it("keeps the same Provider form identity while collapsing and expanding", () => {
    const expanded = newModelFormKey("provider-a", true);
    const collapsed = newModelFormKey("provider-a", false);

    expect(collapsed).toBe(expanded);
  });
});

describe("settings save lifecycle", () => {
  it("passes Panel saving state to the shared navigation tracker", async () => {
    const report = vi.fn();
    lifecycle.context = { report };

    useReportSettingsSave("execution", true);
    await mountEffects();
    expect(report).toHaveBeenLastCalledWith("execution", true);

    cleanups.pop()?.();
    expect(report).toHaveBeenLastCalledWith("execution", false);
  });

  it("reports saving through the completed post-save read", async () => {
    const updating = deferred<Record<string, unknown>>();
    const reading = deferred<void>();
    const update = vi
      .spyOn(backend, "updateSettings")
      .mockReturnValueOnce(updating.promise);
    const load = vi.fn(() => reading.promise);
    lifecycle.setters = [];
    const saver = useSaver(load, { current: null });

    const saved = saver.save("execution", {});
    expect(lifecycle.setters[0]).toHaveBeenCalledWith(true);
    updating.resolve({});
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    expect(lifecycle.setters[0]).not.toHaveBeenCalledWith(false);
    reading.resolve();

    await expect(saved).resolves.toBe(true);
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(false);
    update.mockRestore();
  });

  it("releases saving state after a failed write", async () => {
    lifecycle.setters = [];
    vi.spyOn(backend, "updateSettings").mockRejectedValueOnce(
      new Error("offline"),
    );
    const saver = useSaver(
      vi.fn(async () => {}),
      { current: null },
    );

    await expect(saver.save("execution", {})).resolves.toBe(false);
    expect(lifecycle.setters[0]).toHaveBeenNthCalledWith(1, true);
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(false);
  });
});

describe("model configuration connection recovery", () => {
  it("preserves the Agent draft after a save fails and a new read completes", async () => {
    vi.spyOn(backend, "configureModel").mockRejectedValueOnce(
      new Error("offline"),
    );
    const panel = mountPanel(true);
    await mountEffects();
    panel.edit();
    await panel.save();
    lifecycle.setters[1].mockClear();
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(catalog);
    expect(lifecycle.setters[1]).not.toHaveBeenCalled();
    expect(readToasts().some((item) => item.tone === "danger")).toBe(true);
  });

  it("reloads settings after a failed initial load and releases the listener", async () => {
    vi.mocked(backend.modelCatalog).mockRejectedValueOnce(new Error("offline"));
    ModelPanel();
    await mountEffects();
    expect(lifecycle.setters[2]).toHaveBeenLastCalledWith(true);
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(backend.modelCatalog).toHaveBeenCalledTimes(2);
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(catalog);
    expect(lifecycle.setters[2]).toHaveBeenLastCalledWith(false);
    cleanups.pop()?.();
    expect(off).toHaveBeenCalledOnce();
  });

  it("refreshes saved Agent choices after reconnect", async () => {
    AgentModelPanel({ agentId: 2 });
    await mountEffects();
    const next = {
      ...catalog,
      agent_configs: { "2": { model_id: null, thinking: null } },
    };
    vi.mocked(backend.modelCatalog).mockResolvedValueOnce(next);
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(next);
    expect(lifecycle.setters[1]).toHaveBeenLastCalledWith(
      next.agent_configs["2"],
    );
  });

  it("preserves an edited Agent choice while refreshing model availability", async () => {
    const panel = AgentModelPanel({ agentId: 2 });
    await mountEffects();
    panel.props.onChangeCapture();
    lifecycle.setters[1].mockClear();
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenCalledTimes(2);
    expect(lifecycle.setters[1]).not.toHaveBeenCalled();
  });

  it("refreshes models in Agent creation without changing the draft", async () => {
    AgentCreateDialog({ onClose: vi.fn(), onCreated: vi.fn() });
    await mountEffects();
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenCalledTimes(2);
    expect(lifecycle.setters[1]).not.toHaveBeenCalled();
    expect(lifecycle.setters[2]).not.toHaveBeenCalled();
  });
});
