import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  enqueueDelivery: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    delivery: {
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("../queue/deliveryQueue", () => ({
  enqueueDelivery: mocks.enqueueDelivery,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
  },
}));

import { reconcilePendingDeliveries } from "../queue/reconcile";

describe("delivery reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds the next durable attempt for the current replay run", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "delivery_1",
        runNumber: 2,
        attemptCount: 2,
        nextAttemptAt: new Date("2026-09-12T00:00:20.000Z"),
      },
    ]);
    mocks.enqueueDelivery.mockResolvedValue({ id: "queue-job" });

    const result = await reconcilePendingDeliveries();

    expect(mocks.enqueueDelivery).toHaveBeenCalledWith("delivery_1", 2, 3, 20_000);
    expect(result).toEqual({ checked: 1, repaired: 1, failed: 0 });
  });

  it("continues repairing other deliveries when one projection fails", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "delivery_1", runNumber: 1, attemptCount: 0, nextAttemptAt: null },
      { id: "delivery_2", runNumber: 3, attemptCount: 1, nextAttemptAt: null },
    ]);
    mocks.enqueueDelivery
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce({ id: "queue-job" });

    const result = await reconcilePendingDeliveries();

    expect(mocks.enqueueDelivery).toHaveBeenNthCalledWith(1, "delivery_1", 1, 1, 0);
    expect(mocks.enqueueDelivery).toHaveBeenNthCalledWith(2, "delivery_2", 3, 2, 0);
    expect(result).toEqual({ checked: 2, repaired: 1, failed: 1 });
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
