export class RunCoordinatorBusyError extends Error {
  constructor(message = "Another coordinated run is already in progress") {
    super(message);
    this.name = "RunCoordinatorBusyError";
  }
}

export type CoordinatorMode = "wait" | "fail";

/**
 * Serializes complete treasury-review and accounting runs in-process.
 * Scheduled jobs should wait; manual HTTP triggers should fail fast.
 */
export class RunCoordinator {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async runExclusive<T>(
    task: () => Promise<T>,
    mode: CoordinatorMode = "wait",
  ): Promise<T> {
    if (this.locked) {
      if (mode === "fail") {
        throw new RunCoordinatorBusyError();
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    } else {
      this.locked = true;
    }

    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    }
  }

  get isBusy(): boolean {
    return this.locked;
  }
}
