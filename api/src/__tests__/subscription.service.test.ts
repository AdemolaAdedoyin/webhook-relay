import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma singleton before importing the service under test so the
// service talks to our in-memory fake instead of a real database.
vi.mock("../db", () => {
  const subscriptions = new Map<string, any>();
  let counter = 0;

  return {
    prisma: {
      $queryRaw: vi.fn(async () => []),
      $transaction: async function(work: any) { return work(this); },
      subscription: {
        create: vi.fn(async ({ data }: any) => {
          const id = data.id ?? `sub_${++counter}`;
          const record = { id, status: "ACTIVE", consecutiveFailures: 0, createdAt: new Date(), ...data };
          subscriptions.set(id, record);
          return record;
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          const record = subscriptions.get(where.id);
          return record && record.tenantId === where.tenantId ? record : null;
        }),
        findMany: vi.fn(async ({ where }: any) =>
          [...subscriptions.values()].filter((s) => s.tenantId === where.tenantId)
        ),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const record = subscriptions.get(where.id);
          if (!record || record.tenantId !== where.tenantId || record.archivedAt) return { count: 0 };
          subscriptions.set(where.id, { ...record, ...data }); return { count: 1 };
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const record = { ...subscriptions.get(where.id), ...data };
          subscriptions.set(where.id, record);
          return record;
        }),
        delete: vi.fn(async ({ where }: any) => {
          subscriptions.delete(where.id);
        }),
      },
    },
  };
});

import * as subscriptionService from "../modules/subscriptions/subscription.service";

describe("subscription.service", () => {
  const tenantId = "tenant_1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a subscription and redacts the secret on read but not on create", async () => {
    const created = await subscriptionService.createSubscription({
      tenantId,
      targetUrl: "https://example.com/hooks",
      eventTypes: ["order.created"],
    });
    expect(created.secret).toMatch(/^whsec_/);

    const [fetched] = await subscriptionService.listSubscriptions(tenantId);
    expect((fetched as any).secret).toBeUndefined();
    expect(fetched.secretPreview).toContain("whsec_");
    expect(fetched.secretPreview).toContain("*");
  });

  it("throws NotFoundError when updating a subscription that belongs to another tenant", async () => {
    const created = await subscriptionService.createSubscription({
      tenantId,
      targetUrl: "https://example.com/other",
      eventTypes: [],
    });

    await expect(
      subscriptionService.updateSubscriptionStatus("other_tenant", created.id, "PAUSED")
    ).rejects.toThrow(/not found/i);
  });

  it("resets consecutiveFailures when reactivating a subscription", async () => {
    const created = await subscriptionService.createSubscription({
      tenantId,
      targetUrl: "https://example.com/reactivate",
      eventTypes: [],
    });
    await subscriptionService.updateSubscriptionStatus(tenantId, created.id, "PAUSED");
    const reactivated = await subscriptionService.updateSubscriptionStatus(tenantId, created.id, "ACTIVE");
    expect(reactivated.consecutiveFailures).toBe(0);
  });
});
