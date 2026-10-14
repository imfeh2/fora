export class TestWorkflow {
  private state:
    | "ready"
    | "running"
    | "stopping"
    | "stopped"
    | "completed"
    | "failed" = "ready";
  private readonly interruption = new Error("Test workflow stopped");
  private readonly releases = new Set<() => void>();
  private completion: Promise<void> | null = null;

  get status() {
    return this.state;
  }

  private check() {
    if (this.state === "stopping") throw this.interruption;
    if (this.state !== "running")
      throw new Error(`Test workflow is ${this.state}`);
  }

  run(work: () => Promise<void>) {
    if (this.state !== "ready")
      throw new Error("Test workflow already started");
    this.state = "running";
    this.completion = this.execute(work);
    return this.completion;
  }

  private async execute(work: () => Promise<void>) {
    try {
      await work();
      this.check();
      this.state = "completed";
    } catch (failure) {
      if (failure === this.interruption && this.state === "stopping") {
        this.state = "stopped";
        return;
      }
      this.state = "failed";
      throw failure;
    }
  }

  async step<T>(work: () => T | PromiseLike<T>): Promise<T> {
    this.check();
    const result = await work();
    this.check();
    return result;
  }

  own(release: () => void) {
    this.check();
    this.releases.add(release);
  }

  stop() {
    if (this.state === "running") this.state = "stopping";
  }

  release() {
    for (const release of this.releases) release();
    this.releases.clear();
  }

  wait() {
    if (!this.completion) throw new Error("Test workflow has not started");
    return this.completion;
  }
}
