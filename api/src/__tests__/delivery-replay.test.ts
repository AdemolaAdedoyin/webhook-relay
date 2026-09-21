import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  enqueueDelivery: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    $transaction: async function(work: any) { return work(this); },
    $queryRaw: vi.fn(async () => []),
    delivery: {
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
    },
  },
}));

vi.mock("../queue/deliveryQueue", () => ({
  enqueueDelivery: mocks.enqueueDelivery,
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: mocks.warn },
}));

import { replayDelivery } from "../modules/deliveries/delivery.service";

describe("delivery replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a new run with a fresh retry budget while preserving history", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "delivery_1",
      subscription: { archivedAt: null },
      status: "FAILED",
      runNumber: 1,
      attemptCount: 8,
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUniqueOrThrow.mockResolvedValue({
      id: "delivery_1",
      subscription: { archivedAt: null },
      status: "PENDING",
      runNumber: 2,
      attemptCount: 0,
    });
    mocks.enqueueDelivery.mockResolvedValue({ id: "queue-job" });

    const result = await replayDelivery("tenant_1", "delivery_1");

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "delivery_1", runNumber: 1, status: "FAILED" },
        data: expect.objectContaining({
          runNumber: 2,
          status: "PENDING",
          attemptCount: 0,
          responseStatus: null,
          responseBodySnippet: null,
          errorMessage: null,
        }),
      })
    );
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith("delivery_1", 2, 1);
    expect(result).toMatchObject({ runNumber: 2, attemptCount: 0, status: "PENDING" });
  });

  it("rejects a concurrent replay that already changed the terminal row", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "delivery_1",
      subscription: { archivedAt: null },
      status: "SUCCEEDED",
      runNumber: 2,
      attemptCount: 1,
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(replayDelivery("tenant_1", "delivery_1")).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_IN_FLIGHT",
    });
  });

  it("rejects replay while the delivery is actively processing", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "delivery_1",
      subscription: { archivedAt: null },
      status: "PROCESSING",
      runNumber: 1,
      attemptCount: 1,
    });

    await expect(replayDelivery("tenant_1", "delivery_1")).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_IN_FLIGHT",
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
