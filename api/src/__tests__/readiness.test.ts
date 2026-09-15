import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../db", () => ({ prisma: {} }));
import { createReadinessProbe } from "../lib/readiness";
afterEach(() => vi.useRealTimers());

describe("dependency readiness", () => {
  it("reports dependency failures without leaking connection errors", async () => {
    const probe = createReadinessProbe(async () => {}, async () => { throw new Error("credential-bearing URL"); });
    expect(await probe()).toEqual({ status: "not_ready", checks: { postgres: true, redis: false } });
  });
  it("bounds a stalled dependency and reuses its pending probe", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const database = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const probe = createReadinessProbe(database, async () => {}, 100);
    const first = probe();
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).status).toBe("not_ready");
    const second = probe();
    await vi.advanceTimersByTimeAsync(100);
    expect((await second).checks.postgres).toBe(false);
    expect(database).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    database.mockResolvedValue(undefined);
    expect((await probe()).status).toBe("ready");
  });
});
