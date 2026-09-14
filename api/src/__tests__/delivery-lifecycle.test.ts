import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    delivery: {
      updateMany: mocks.updateMany,
    },
  },
}));

import { claimDeliveryAttempt } from "../queue/deliveryLifecycle";

describe("delivery attempt claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims only the expected run and attempt before processing", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(claimDeliveryAttempt("delivery_1", 3, 2)).resolves.toBe(true);

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "delivery_1",
          runNumber: 3,
          attemptCount: 1,
          status: { in: ["PENDING", "RETRYING"] },
        },
        data: expect.objectContaining({
          status: "PROCESSING",
          attemptCount: 2,
          lastAttemptAt: expect.any(Date),
          processingHeartbeatAt: expect.any(Date),
          nextAttemptAt: null,
        }),
      })
    );
  });

  it("reports a lost claim so a duplicate worker performs no side effect", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(claimDeliveryAttempt("delivery_1", 1, 1)).resolves.toBe(false);
  });
});
