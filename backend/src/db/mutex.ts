/** Fair async mutex: callers run one at a time, in arrival order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Enter the mutex and get a release function (held across awaits). */
  async enter(): Promise<() => void> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    return release;
  }
}
