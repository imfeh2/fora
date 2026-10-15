export class TestInitializationCleanupError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super("Test initialization cleanup failed");
    this.name = "TestInitializationCleanupError";
  }
}

export class TestInitialization {
  private closing = false;
  private initialization: Promise<void> | null = null;
  private closure: Promise<void> | null = null;
  private initializationFailure: { error: unknown } | null = null;
  private closeDom: (() => void) | null = null;
  private restoreGlobals: (() => void) | null = null;
  private drain: (() => Promise<void>) | null = null;

  run(work: () => Promise<void>) {
    if (this.initialization || this.closing)
      throw new Error("Test initialization already started or closed");
    this.initialization = this.execute(work);
    return this.initialization;
  }

  private async execute(work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      this.initializationFailure = { error };
      throw error;
    }
  }

  async acquire<T>(load: () => Promise<T>, publish: (value: T) => void) {
    if (this.closing) return false;
    const value = await load();
    if (this.closing) return false;
    publish(value);
    return true;
  }

  ownDom(close: () => void) {
    if (this.closing || this.closeDom)
      throw new Error("Test DOM already owned or closed");
    this.closeDom = close;
  }

  ownGlobals(restore: () => void) {
    if (this.closing || this.restoreGlobals)
      throw new Error("Test globals already owned or closed");
    this.restoreGlobals = restore;
  }

  ownDrain(drain: () => Promise<void>) {
    if (this.closing || this.drain)
      throw new Error("Test drain already owned or closed");
    this.drain = drain;
  }

  close() {
    this.closing = true;
    this.closure ??= Promise.resolve().then(() => this.release());
    return this.closure;
  }

  private async release() {
    const drain = this.drain;
    const closeDom = this.closeDom;
    const restoreGlobals = this.restoreGlobals;
    this.drain = null;
    this.closeDom = null;
    this.restoreGlobals = null;
    const errors: unknown[] = [];
    try {
      if (drain) await drain();
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (closeDom) closeDom();
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          if (restoreGlobals) restoreGlobals();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length) {
      if (this.initializationFailure)
        errors.unshift(this.initializationFailure.error);
      throw new TestInitializationCleanupError(errors);
    }
  }
}
