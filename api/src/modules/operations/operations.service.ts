import { DeliveryStatus, SubscriptionStatus, Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { config } from "../../config";

export async function getOperationsOverview(tenantId: string) {
  const cutoff = new Date(Date.now() - config.DELIVERY_PROCESSING_STALE_MS);
  // A consistent PostgreSQL snapshot across all worker replicas; no global queue
  // counts or tenant identifiers leak through this tenant-authenticated surface.
  return prisma.$transaction(async (tx) => {
    const deliveries = Object.fromEntries(Object.values(DeliveryStatus).map((s) => [s, 0]));
    for (const row of await tx.delivery.groupBy({ by: ["status"], where: { subscription: { tenantId } }, _count: { _all: true } })) {
      deliveries[row.status] = row._count._all;
    }
    const subscriptions = Object.fromEntries(Object.values(SubscriptionStatus).map((s) => [s, 0]));
    for (const row of await tx.subscription.groupBy({ by: ["status"], where: { tenantId, archivedAt: null }, _count: { _all: true } })) {
      subscriptions[row.status] = row._count._all;
    }
    const events = await tx.event.count({ where: { tenantId } });
    const staleProcessing = await tx.delivery.count({ where: {
      subscription: { tenantId }, status: "PROCESSING",
      OR: [{ processingHeartbeatAt: { lte: cutoff } }, { processingHeartbeatAt: null, lastAttemptAt: { lte: cutoff } }],
    } });
    return { deliveries, subscriptions, events, staleProcessing };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function formatOperationsMetrics(overview: Awaited<ReturnType<typeof getOperationsOverview>>) {
  const lines = [
    "# HELP relay_deliveries Current durable deliveries by status for the authenticated tenant.",
    "# TYPE relay_deliveries gauge",
    ...Object.values(DeliveryStatus).map((status) => `relay_deliveries{status="${status}"} ${overview.deliveries[status] ?? 0}`),
    "# HELP relay_subscriptions Current subscriptions by status for the authenticated tenant.",
    "# TYPE relay_subscriptions gauge",
    ...Object.values(SubscriptionStatus).map((status) => `relay_subscriptions{status="${status}"} ${overview.subscriptions[status] ?? 0}`),
    "# HELP relay_events Current retained events for the authenticated tenant.",
    "# TYPE relay_events gauge",
    `relay_events ${overview.events}`,
    "# HELP relay_stale_processing Deliveries with an expired processing lease.",
    "# TYPE relay_stale_processing gauge",
    `relay_stale_processing ${overview.staleProcessing}`,
  ];
  return lines.join("\n") + "\n";
}
