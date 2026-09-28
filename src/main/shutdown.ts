import type { DbusClient } from "@open-orpheus/dbus";
import os from "node:os";

import { registerShutdownTask } from "./lifecycle";
import { toError } from "../util";

/** The logind manager object, shared by every call below. */
const LOGIND_MANAGER = {
  destination: "org.freedesktop.login1",
  path: "/org/freedesktop/login1",
  interfaceName: "org.freedesktop.login1.Manager",
} as const;

let dbusClient: DbusClient | null = null;

/**
 * The shutdown time (microseconds since the epoch) this app last scheduled, or
 * `null` when it currently has no schedule of its own.
 */
let currentShutdownSchedule: number | null = null;

export enum ScheduleShutdownStatus {
  /** The requested state is now in effect. */
  Ok,
  /** This platform, or the system, cannot schedule a shutdown. */
  NotAvailable,
  /** The requested state already held, so nothing changed. */
  AlreadySet,
  /** Another application owns the system's shutdown schedule. */
  ManagedExternally,
  /** The request could not be completed (e.g. the bus is unreachable). */
  Failed,
}

/** Whether this app owns a scheduled shutdown (or is busy creating one). */
export function hasManagedScheduledShutdown(): boolean {
  return currentShutdownSchedule !== null || requestsInFlight > 0;
}

// Requests are serialized so that a set and a cancel complete in the order they
// were issued. Otherwise a cancel that is issued while an earlier set is still
// on the bus can answer first, and the set then reactivates the schedule the
// user just cancelled.
let pendingRequest: Promise<unknown> = Promise.resolve();
let requestsInFlight = 0;

function enqueue<T>(request: () => Promise<T>): Promise<T> {
  requestsInFlight++;
  const result = pendingRequest.then(request, request);
  const settled = () => {
    requestsInFlight--;
  };
  result.then(settled, settled);
  // Keep the chain alive whatever the outcome of this request.
  pendingRequest = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function getClient(): Promise<DbusClient> {
  if (!dbusClient) {
    dbusClient = new (await import("@open-orpheus/dbus")).DbusClient("system");
  }
  return dbusClient;
}

/**
 * Set the machine shutdown this app manages, or cancel it when `time` is
 * omitted.
 *
 * Requests run one at a time, in the order they arrive, so the last request
 * always wins even while an earlier one is still waiting on the system bus.
 * Failures are reported as {@link ScheduleShutdownStatus.Failed} rather than
 * rejected, so callers (including IPC handlers) always get an answer.
 */
export function setScheduledShutdown(
  time?: Date
): Promise<ScheduleShutdownStatus> {
  return enqueue(() => applyScheduledShutdown(time));
}

async function applyScheduledShutdown(
  time?: Date
): Promise<ScheduleShutdownStatus> {
  if (os.platform() !== "linux") return ScheduleShutdownStatus.NotAvailable;

  // Client creation is inside the guarded region: connecting to the system bus
  // can fail (no bus, sandbox denial), which must become a failure status, not
  // a rejected promise that leaves the caller without a reply.
  let client: DbusClient;
  try {
    client = await getClient();
  } catch (err) {
    LOGGER.warn({ err: toError(err) }, "Failed to connect to the system bus");
    return ScheduleShutdownStatus.Failed;
  }

  try {
    const [canPoweroffRes, scheduledShutdownRes] = await Promise.all([
      client.call({ ...LOGIND_MANAGER, method: "CanPowerOff" }),
      client.getProperty({ ...LOGIND_MANAGER, name: "ScheduledShutdown" }),
    ]);
    const canPoweroff = canPoweroffRes.body[0] as string;
    if (canPoweroff !== "yes" && canPoweroff !== "challenge") {
      // System is not available for shutdown.
      return ScheduleShutdownStatus.NotAvailable;
    }
    const systemShutdownSchedule = scheduledShutdownRes.value as [
      string | "",
      number,
    ];
    // The shutdown schedule isn't managed by us
    if (
      systemShutdownSchedule[0] &&
      (systemShutdownSchedule[0] !== "poweroff" ||
        systemShutdownSchedule[1] !== currentShutdownSchedule)
    ) {
      currentShutdownSchedule = null;
      return ScheduleShutdownStatus.ManagedExternally;
    }
    if (time === undefined) {
      if (currentShutdownSchedule === null)
        return ScheduleShutdownStatus.AlreadySet;
      await client.call({
        ...LOGIND_MANAGER,
        method: "CancelScheduledShutdown",
      });
      currentShutdownSchedule = null;
    } else {
      const shutdownTime = time.valueOf() * 1000;
      if (shutdownTime === currentShutdownSchedule)
        return ScheduleShutdownStatus.AlreadySet;
      await client.call({
        ...LOGIND_MANAGER,
        method: "ScheduleShutdown",
        signature: "st",
        body: ["poweroff", shutdownTime],
      });
      currentShutdownSchedule = shutdownTime;
    }
  } catch (err) {
    // The system refused the request (or it could not be delivered). Report it
    // so the caller knows the schedule is not what it asked for.
    LOGGER.warn(
      { err: toError(err), time },
      "Failed to update shutdown schedule"
    );
    return ScheduleShutdownStatus.Failed;
  }
  return ScheduleShutdownStatus.Ok;
}

/**
 * Set once the in-app countdown reaches zero: the shutdown that follows is the
 * intended outcome and must survive the quit the timer starts.
 */
let keepScheduleOnExit = false;

/** Mark that the pending quit is performing the scheduled shutdown. */
export function keepScheduledShutdownOnExit(): void {
  keepScheduleOnExit = true;
}

// A normal quit must not leave the machine set to power off. Only the timer
// above keeps the schedule; every other exit cancels the schedule this app
// owns, so quitting early keeps the machine on.
registerShutdownTask({
  name: "scheduled-shutdown",
  timeoutMs: 1500,
  run: async () => {
    if (keepScheduleOnExit) return;
    // Nothing to do when this app has no schedule (and none is being created).
    if (!hasManagedScheduledShutdown()) return;
    const status = await setScheduledShutdown();
    if (
      status !== ScheduleShutdownStatus.Ok &&
      status !== ScheduleShutdownStatus.AlreadySet
    ) {
      LOGGER.warn(
        { status },
        "Failed to cancel the scheduled shutdown on exit"
      );
    }
  },
});
