import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";

import { installLoggerStub } from "../helpers/globals";

installLoggerStub();

type ScheduledShutdown = [string | "", number];

const hoisted = vi.hoisted(() => ({
  /** Every method name passed to the fake bus, in call order. */
  calls: [] as string[],
  /** What the logind `ScheduledShutdown` property reports. */
  scheduled: ["", 0] as [string | "", number],
  /** Refuse `ScheduleShutdown` like an unprivileged caller would be refused. */
  failSchedule: false,
  /** Fail to connect to the system bus at all. */
  failConstruct: false,
  /** Hold a `ScheduleShutdown` call open until the test releases it. */
  gateSchedule: false,
  /** Resolver for a `ScheduleShutdown` call the test wants to hold open. */
  release: null as null | (() => void),
  /** Shutdown tasks registered by the module under test. */
  tasks: [] as Array<{ name: string; run: () => void | Promise<void> }>,
}));

vi.mock("@open-orpheus/dbus", () => {
  class DbusClient {
    constructor(bus: string) {
      if (hoisted.failConstruct) throw new Error("no system bus");
      if (bus !== "system") throw new Error(`unexpected bus ${bus}`);
    }

    async call(options: { method: string; body?: unknown[] }) {
      hoisted.calls.push(options.method);
      switch (options.method) {
        case "CanPowerOff":
          return { signature: "s", body: ["yes"] };
        case "ScheduleShutdown": {
          if (hoisted.failSchedule) throw new Error("access denied");
          if (hoisted.gateSchedule) {
            await new Promise<void>((resolve) => {
              hoisted.release = resolve;
            });
          }
          hoisted.scheduled = ["poweroff", options.body?.[1] as number];
          return { signature: "", body: [] };
        }
        case "CancelScheduledShutdown":
          hoisted.scheduled = ["", 0];
          return { signature: "", body: [] };
        default:
          throw new Error(`unexpected method ${options.method}`);
      }
    }

    async getProperty() {
      return {
        signature: "(st)",
        value: [...hoisted.scheduled] as ScheduledShutdown,
      };
    }
  }

  return { DbusClient };
});

// `shutdown.ts` only needs the registration hook; importing the real module
// would pull Electron in.
vi.mock("../../src/main/lifecycle", () => ({
  registerShutdownTask: (task: {
    name: string;
    run: () => void | Promise<void>;
  }) => hoisted.tasks.push(task),
}));

async function loadModule() {
  return import("../../src/main/shutdown");
}

/** Wait until `predicate` holds, failing if it never does. */
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for the fake bus");
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(os, "platform").mockReturnValue("linux");
  hoisted.calls = [];
  hoisted.scheduled = ["", 0];
  hoisted.failSchedule = false;
  hoisted.failConstruct = false;
  hoisted.gateSchedule = false;
  hoisted.release = null;
  hoisted.tasks = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setScheduledShutdown", () => {
  it("reports failure instead of rejecting when the system bus is unreachable", async () => {
    hoisted.failConstruct = true;
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(setScheduledShutdown(new Date())).resolves.toBe(
      ScheduleShutdownStatus.Failed
    );
  });

  it("reports failure when the system refuses the request", async () => {
    hoisted.failSchedule = true;
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(
      setScheduledShutdown(new Date(Date.now() + 60_000))
    ).resolves.toBe(ScheduleShutdownStatus.Failed);
  });

  it("leaves an external schedule alone", async () => {
    hoisted.scheduled = ["poweroff", 1_234_567];
    const {
      ScheduleShutdownStatus,
      setScheduledShutdown,
      hasManagedScheduledShutdown,
    } = await loadModule();

    await expect(
      setScheduledShutdown(new Date(Date.now() + 60_000))
    ).resolves.toBe(ScheduleShutdownStatus.ManagedExternally);
    expect(hoisted.calls).toEqual(["CanPowerOff"]);
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("treats a cancel with no managed schedule as already satisfied", async () => {
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(setScheduledShutdown()).resolves.toBe(
      ScheduleShutdownStatus.AlreadySet
    );
    expect(hoisted.calls).toEqual(["CanPowerOff"]);
  });

  it("runs a cancel issued during a set after the set, not before it", async () => {
    const {
      ScheduleShutdownStatus,
      setScheduledShutdown,
      hasManagedScheduledShutdown,
    } = await loadModule();

    hoisted.gateSchedule = true;
    const set = setScheduledShutdown(new Date(Date.now() + 60_000));
    await waitFor(() => hoisted.release !== null);
    // The cancel arrives while the set is still on the bus.
    const cancel = setScheduledShutdown();
    hoisted.release!();

    await expect(set).resolves.toBe(ScheduleShutdownStatus.Ok);
    await expect(cancel).resolves.toBe(ScheduleShutdownStatus.Ok);
    expect(hoisted.calls).toEqual([
      "CanPowerOff",
      "ScheduleShutdown",
      "CanPowerOff",
      "CancelScheduledShutdown",
    ]);
    expect(hasManagedScheduledShutdown()).toBe(false);
  });
});

describe("shutdown task", () => {
  function task() {
    const found = hoisted.tasks.find((t) => t.name === "scheduled-shutdown");
    if (!found) throw new Error("the shutdown task was not registered");
    return found;
  }

  it("cancels the schedule this app owns on a normal quit", async () => {
    const { setScheduledShutdown, hasManagedScheduledShutdown } =
      await loadModule();
    await setScheduledShutdown(new Date(Date.now() + 60_000));

    await task().run();

    expect(hoisted.calls).toContain("CancelScheduledShutdown");
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("keeps the schedule when the countdown itself triggers the quit", async () => {
    const {
      setScheduledShutdown,
      keepScheduledShutdownOnExit,
      hasManagedScheduledShutdown,
    } = await loadModule();
    await setScheduledShutdown(new Date(Date.now() + 60_000));

    keepScheduledShutdownOnExit();
    await task().run();

    expect(hoisted.calls).not.toContain("CancelScheduledShutdown");
    expect(hasManagedScheduledShutdown()).toBe(true);
  });
});
