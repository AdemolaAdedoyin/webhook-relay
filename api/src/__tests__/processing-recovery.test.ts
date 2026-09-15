import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  enqueueDelivery: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    delivery: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
  },
}));

vi.mock("../config", () => ({
  config: {
    DELIVERY_PROCESSING_STALE_MS: 60_000,
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

import {
  recoverStaleProcessingDeliveries,
  refreshProcessingLease,
} from "../queue/processingRecovery";

describe("stale delivery processing recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the lease only while the expected run/attempt still owns PROCESSING", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(refreshProcessingLease("delivery_1", 2, 3)).resolves.toBe(true);

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "delivery_1",
          runNumber: 2,
          attemptCount: 3,
          status: "PROCESSING",
        },
        data: { processingHeartbeatAt: expect.any(Date) },
      })
    );
  });

  it("releases a stale in-flight attempt and projects the next attempt", async () => {
    const staleHeartbeat = new Date("2026-09-14T12:00:00.000Z");
    const now = new Date("2026-09-14T12:02:00.000Z");
    mocks.findMany.mockResolvedValue([
      {
        id: "delivery_1",
        runNumber: 4,
        attemptCount: 2,
        maxAttempts: 8,
        processingHeartbeatAt: staleHeartbeat,
        lastAttemptAt: staleHeartbeat,
      },
    ]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.enqueueDelivery.mockResolvedValue({ id: "queue_job" });

    await expect(recoverStaleProcessingDeliveries(now)).resolves.toEqual({
      checked: 1,
      recovered: 1,
      exhausted: 0,
      projectionFailures: 0,
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "delivery_1",
          runNumber: 4,
          attemptCount: 2,
          status: "PROCESSING",
          processingHeartbeatAt: staleHeartbeat,
        }),
        data: expect.objectContaining({
          status: "RETRYING",
          processingHeartbeatAt: null,
          nextAttemptAt: now,
        }),
      })
    );
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith("delivery_1", 4, 3, 0);
  });

  it("marks an exhausted stale attempt failed without charging the subscriber", async () => {
    const staleHeartbeat = new Date("2026-09-14T12:00:00.000Z");
    mocks.findMany.mockResolvedValue([
      {
        id: "delivery_2",
        runNumber: 1,
        attemptCount: 8,
        maxAttempts: 8,
        processingHeartbeatAt: staleHeartbeat,
        lastAttemptAt: staleHeartbeat,
      },
    ]);
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      recoverStaleProcessingDeliveries(new Date("2026-09-14T12:02:00.000Z"))
    ).resolves.toEqual({
      checked: 1,
      recovered: 0,
      exhausted: 1,
      projectionFailures: 0,
    });

    expect(mocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          processingHeartbeatAt: null,
          nextAttemptAt: null,
        }),
      })
    );
  });

  it("does not project work when another worker already changed the stale row", async () => {
    const staleHeartbeat = new Date("2026-09-14T12:00:00.000Z");
    mocks.findMany.mockResolvedValue([
      {
        id: "delivery_3",
        runNumber: 1,
        attemptCount: 1,
        maxAttempts: 8,
        processingHeartbeatAt: staleHeartbeat,
        lastAttemptAt: staleHeartbeat,
      },
    ]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await recoverStaleProcessingDeliveries(new Date("2026-09-14T12:02:00.000Z"));

    expect(mocks.enqueueDelivery).not.toHaveBeenCalled();
  });
});
