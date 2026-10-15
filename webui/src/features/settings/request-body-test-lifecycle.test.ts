import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TestInitialization,
  TestInitializationCleanupError,
} from "@/features/settings/request-body-test-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const globalName = "__requestBodyInitializationTest";

afterEach(() => vi.unstubAllGlobals());

describe("Request body test initialization", () => {
  it("closes while the initial import remains pending and ignores its late result", async () => {
    const scope = new TestInitialization();
    const loading = deferred<object>();
    const closeDom = vi.fn();
    const restoreGlobals = vi.fn();
    const publish = vi.fn(() => {
      scope.ownDom(closeDom);
      scope.ownGlobals(restoreGlobals);
    });
    const nextLoad = vi.fn(async () => ({}));
    const nextPublish = vi.fn();
    let finished = false;
    const initialization = scope.run(async () => {
      if (!(await scope.acquire(() => loading.promise, publish))) return;
      await scope.acquire(nextLoad, nextPublish);
    });
    const observed = initialization.then(() => {
      finished = true;
    });
    await scope.close();
    expect(finished).toBe(false);
    expect(closeDom).not.toHaveBeenCalled();
    expect(restoreGlobals).not.toHaveBeenCalled();
    loading.resolve({});
    await observed;
    expect(finished).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(nextLoad).not.toHaveBeenCalled();
    expect(nextPublish).not.toHaveBeenCalled();
    expect(await scope.acquire(nextLoad, nextPublish)).toBe(false);
    expect(nextLoad).not.toHaveBeenCalled();
  });

  it("does not wait for a native import that never returns", async () => {
    const scope = new TestInitialization();
    const publish = vi.fn();
    const loading = new Promise<never>(() => {});
    scope.run(async () => {
      await scope.acquire(() => loading, publish);
    });
    await scope.close();
    expect(publish).not.toHaveBeenCalled();
  });

  it("releases a partial DOM once and keeps late initialization separate from the next owner", async () => {
    const scope = new TestInitialization();
    const loading = deferred<object>();
    const entered = deferred<void>();
    const closeDom = vi.fn();
    const restoreGlobals = vi.fn(() => vi.unstubAllGlobals());
    const publishTesting = vi.fn();
    const nextLoad = vi.fn(async () => ({}));
    const initialization = scope.run(async () => {
      if (
        !(await scope.acquire(
          async () => ({}),
          () => {
            scope.ownDom(closeDom);
            scope.ownGlobals(restoreGlobals);
            vi.stubGlobal(globalName, "old");
          },
        ))
      )
        return;
      if (
        !(await scope.acquire(() => {
          entered.resolve();
          return loading.promise;
        }, publishTesting))
      )
        return;
      await scope.acquire(nextLoad, vi.fn());
    });
    await entered.promise;
    expect(Reflect.get(globalThis, globalName)).toBe("old");
    const closing = scope.close();
    expect(scope.close()).toBe(closing);
    await closing;
    expect(closeDom).toHaveBeenCalledTimes(1);
    expect(restoreGlobals).toHaveBeenCalledTimes(1);
    expect(Reflect.get(globalThis, globalName)).toBeUndefined();

    const next = new TestInitialization();
    await next.run(async () => {
      await next.acquire(
        async () => ({}),
        () => {
          next.ownGlobals(() => vi.unstubAllGlobals());
          vi.stubGlobal(globalName, "next");
        },
      );
    });
    loading.resolve({});
    await initialization;
    await scope.close();
    expect(publishTesting).not.toHaveBeenCalled();
    expect(nextLoad).not.toHaveBeenCalled();
    expect(Reflect.get(globalThis, globalName)).toBe("next");
    expect(closeDom).toHaveBeenCalledTimes(1);
    expect(restoreGlobals).toHaveBeenCalledTimes(1);
    await next.close();
    expect(Reflect.get(globalThis, globalName)).toBeUndefined();
  });

  it("preserves a late import rejection after cleanup has completed", async () => {
    const scope = new TestInitialization();
    const loading = deferred<object>();
    const failure = new Error("Initial import rejected");
    const publish = vi.fn();
    const initialization = scope.run(async () => {
      await scope.acquire(() => loading.promise, publish);
    });
    const rejected = expect(initialization).rejects.toBe(failure);
    await scope.close();
    loading.reject(failure);
    await rejected;
    expect(publish).not.toHaveBeenCalled();
    await scope.close();
  });

  it("preserves initialization failure and releases resources acquired before it", async () => {
    const scope = new TestInitialization();
    const failure = new Error("Testing Library import rejected");
    const closeDom = vi.fn();
    const restoreGlobals = vi.fn(() => vi.unstubAllGlobals());
    const initialization = scope.run(async () => {
      scope.ownDom(closeDom);
      scope.ownGlobals(restoreGlobals);
      vi.stubGlobal(globalName, "partial");
      await scope.acquire(() => Promise.reject(failure), vi.fn());
    });
    await expect(initialization).rejects.toBe(failure);
    await scope.close();
    expect(closeDom).toHaveBeenCalledTimes(1);
    expect(restoreGlobals).toHaveBeenCalledTimes(1);
    expect(Reflect.get(globalThis, globalName)).toBeUndefined();
  });

  it("releases resources when publishing initialization throws", async () => {
    const scope = new TestInitialization();
    const failure = new Error("Global initialization failed");
    const closeDom = vi.fn();
    const restoreGlobals = vi.fn(() => vi.unstubAllGlobals());
    const initialization = scope.run(async () => {
      await scope.acquire(
        async () => ({}),
        () => {
          scope.ownDom(closeDom);
          scope.ownGlobals(restoreGlobals);
          vi.stubGlobal(globalName, "partial");
          throw failure;
        },
      );
    });
    await expect(initialization).rejects.toBe(failure);
    await scope.close();
    expect(closeDom).toHaveBeenCalledTimes(1);
    expect(restoreGlobals).toHaveBeenCalledTimes(1);
    expect(Reflect.get(globalThis, globalName)).toBeUndefined();
  });

  it("drains an initialized test before closing DOM and restoring globals once", async () => {
    const scope = new TestInitialization();
    const drained = deferred<void>();
    const entered = deferred<void>();
    const order: string[] = [];
    const drain = vi.fn(async () => {
      order.push("drain:start");
      entered.resolve();
      await drained.promise;
      order.push("drain:end");
    });
    const closeDom = vi.fn(() => order.push("DOM:close"));
    const restoreGlobals = vi.fn(() => order.push("globals:restore"));
    await scope.run(async () => {
      scope.ownDom(closeDom);
      scope.ownGlobals(restoreGlobals);
      scope.ownDrain(drain);
    });
    const closing = scope.close();
    expect(scope.close()).toBe(closing);
    await entered.promise;
    expect(order).toEqual(["drain:start"]);
    drained.resolve();
    await closing;
    await scope.close();
    expect(order).toEqual([
      "drain:start",
      "drain:end",
      "DOM:close",
      "globals:restore",
    ]);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(closeDom).toHaveBeenCalledTimes(1);
    expect(restoreGlobals).toHaveBeenCalledTimes(1);
  });

  it.each(["drain", "DOM", "globals"])(
    "preserves %s cleanup failure and completes every release once",
    async (stage) => {
      const scope = new TestInitialization();
      const failure = new Error(`${stage} failed`);
      const drain = vi.fn(async () => {
        if (stage === "drain") throw failure;
      });
      const closeDom = vi.fn(() => {
        if (stage === "DOM") throw failure;
      });
      const restoreGlobals = vi.fn(() => {
        vi.unstubAllGlobals();
        if (stage === "globals") throw failure;
      });
      await scope.run(async () => {
        scope.ownDom(closeDom);
        scope.ownGlobals(restoreGlobals);
        scope.ownDrain(drain);
        vi.stubGlobal(globalName, "initialized");
      });
      const closing = scope.close();
      expect(scope.close()).toBe(closing);
      await expect(closing).rejects.toMatchObject({ errors: [failure] });
      await expect(scope.close()).rejects.toMatchObject({ errors: [failure] });
      expect(drain).toHaveBeenCalledTimes(1);
      expect(closeDom).toHaveBeenCalledTimes(1);
      expect(restoreGlobals).toHaveBeenCalledTimes(1);
      expect(Reflect.get(globalThis, globalName)).toBeUndefined();
    },
  );

  it("retains initialization, drain, DOM and globals errors together", async () => {
    const scope = new TestInitialization();
    const initializationFailure = new Error("Initialization failed");
    const drainFailure = new Error("Drain failed");
    const closeFailure = new Error("DOM close failed");
    const restoreFailure = new Error("Globals restore failed");
    const drain = vi.fn(async () => {
      throw drainFailure;
    });
    const closeDom = vi.fn(() => {
      throw closeFailure;
    });
    const restoreGlobals = vi.fn(() => {
      vi.unstubAllGlobals();
      throw restoreFailure;
    });
    const initialization = scope.run(async () => {
      scope.ownDom(closeDom);
      scope.ownGlobals(restoreGlobals);
      scope.ownDrain(drain);
      vi.stubGlobal(globalName, "partial");
      throw initializationFailure;
    });
    await expect(initialization).rejects.toBe(initializationFailure);
    const closing = scope.close();
    expect(scope.close()).toBe(closing);
    await expect(closing).rejects.toBeInstanceOf(
      TestInitializationCleanupError,
    );
    await expect(closing).rejects.toMatchObject({
      errors: [
        initializationFailure,
        drainFailure,
        closeFailure,
        restoreFailure,
      ],
    });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(closeDom).toHaveBeenCalledTimes(1);
    expect(restoreGlobals).toHaveBeenCalledTimes(1);
    expect(Reflect.get(globalThis, globalName)).toBeUndefined();
  });
});
