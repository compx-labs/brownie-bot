import { describe, expect, it } from "vitest";

import {
  RunCoordinator,
  RunCoordinatorBusyError,
} from "../src/services/run-coordinator.js";

describe("RunCoordinator", () => {
  it("serializes waiting jobs", async () => {
    const coordinator = new RunCoordinator();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.runExclusive(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
      return 1;
    }, "wait");
    const second = coordinator.runExclusive(() => {
      order.push("second");
      return Promise.resolve(2);
    }, "wait");

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("fails fast for manual mode when busy", async () => {
    const coordinator = new RunCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.runExclusive(async () => {
      await gate;
      return "ok";
    }, "wait");
    await Promise.resolve();
    await expect(
      coordinator.runExclusive(() => Promise.resolve("nope"), "fail"),
    ).rejects.toBeInstanceOf(RunCoordinatorBusyError);
    release();
    await first;
  });
});
