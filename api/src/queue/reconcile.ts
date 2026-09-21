import { prisma } from "../db";
import { logger } from "../lib/logger";
import { enqueueDelivery } from "./deliveryQueue";

let cursor: string | undefined;

export async function reconcilePendingDeliveries() {
  const deliveries = await prisma.delivery.findMany({
    where: { status: { in: ["PENDING", "RETRYING"] }, ...(cursor ? { id: { gt: cursor } } : {}),
      OR: [{ subscription: { status: { not: "PAUSED" } } }, { subscription: { archivedAt: { not: null } } }],
    },
    orderBy: { id: "asc" },
    take: 1_000,
    select: {
      id: true,
      runNumber: true,
      attemptCount: true,
      nextAttemptAt: true,
    },
  });

  // Advance across passes so a large delayed backlog cannot starve newer work.
  cursor = deliveries.length === 1000 ? deliveries[deliveries.length - 1]!.id : undefined;
  let repaired = 0;
  let failed = 0;

  for (const delivery of deliveries) {
    const attemptNumber = delivery.attemptCount + 1;
    const delayMs = delivery.nextAttemptAt
      ? Math.max(0, delivery.nextAttemptAt.getTime() - Date.now())
      : 0;

    try {
      await enqueueDelivery(delivery.id, delivery.runNumber, attemptNumber, delayMs);
      repaired += 1;
    } catch (error) {
      failed += 1;
      logger.warn(
        {
          err: error,
          deliveryId: delivery.id,
          runNumber: delivery.runNumber,
          attemptNumber,
        },
        "failed to reconcile delivery queue projection"
      );
    }
  }

  logger.info(
    { checked: deliveries.length, repaired, failed },
    "delivery queue reconciliation completed"
  );

  return { checked: deliveries.length, repaired, failed };
}
