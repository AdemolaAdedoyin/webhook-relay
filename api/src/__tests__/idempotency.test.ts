import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  transaction: vi.fn(),
  enqueueDelivery: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    event: { findUnique: mocks.findUnique },
    subscription: { findMany: mocks.findMany },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../queue/deliveryQueue", () => ({
  enqueueDelivery: mocks.enqueueDelivery,
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: mocks.warn },
}));

import { fingerprintEventRequest } from "../lib/idempotency";
import { publishEvent } from "../modules/events/event.service";

describe("event idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces the same fingerprint regardless of object key order", () => {
    const first = fingerprintEventRequest("order.created", {
      orderId: "ord_123",
      nested: { amount: 4200, currency: "USD" },
    });
    const second = fingerprintEventRequest("order.created", {
      nested: { currency: "USD", amount: 4200 },
      orderId: "ord_123",
    });

    expect(first).toBe(second);
  });

  it("returns the original event for a matching idempotency replay", async () => {
    const payload = { orderId: "ord_123" };
    const fingerprint = fingerprintEventRequest("order.created", payload);

    mocks.findUnique.mockResolvedValue({
      id: "evt_1",
      tenantId: "tenant_1",
      type: "order.created",
      payload,
      idempotencyKey: "request-1",
      idempotencyFingerprint: fingerprint,
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
      _count: { deliveries: 2 },
    });

    const result = await publishEvent({
      tenantId: "tenant_1",
      type: "order.created",
      payload,
      idempotencyKey: "request-1",
    });

    expect(result.event.id).toBe("evt_1");
    expect(result.deliveryCount).toBe(2);
    expect(result.idempotentReplay).toBe(true);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects reuse of the same key for different work", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "evt_1",
      tenantId: "tenant_1",
      type: "order.created",
      payload: { orderId: "ord_123" },
      idempotencyKey: "request-1",
      idempotencyFingerprint: fingerprintEventRequest("order.created", { orderId: "ord_123" }),
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
      _count: { deliveries: 1 },
    });

    await expect(
      publishEvent({
        tenantId: "tenant_1",
        type: "order.created",
        payload: { orderId: "ord_DIFFERENT" },
        idempotencyKey: "request-1",
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });
});
