import { afterEach, describe, expect, it, vi } from "vitest";
import { startMaintenanceLoop } from "../queue/maintenanceLoop";

afterEach(() => vi.useRealTimers());

describe("worker maintenance lifecycle", () => {
  it("waits for an active pass at shutdown and prevents overlapping or later passes", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = startMaintenanceLoop(run, 100, vi.fn());
    await vi.advanceTimersByTimeAsync(350);
    expect(run).toHaveBeenCalledTimes(1);

    let closed = false;
    const draining = stop().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(closed).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await draining;
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("reports a failed pass and permits the next scheduled pass", async () => {
    vi.useFakeTimers();
    const error = new Error("database unavailable");
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startMaintenanceLoop(run, 100, onError);
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(error);
    expect(run).toHaveBeenCalledTimes(2);
    await stop();
  });
});
