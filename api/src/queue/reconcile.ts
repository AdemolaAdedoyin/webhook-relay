import { prisma } from "../db";
import { logger } from "../lib/logger";
import { enqueueDelivery } from "./deliveryQueue";

export async function reconcilePendingDeliveries() {
  const deliveries = await prisma.delivery.findMany({
    where: { status: { in: ["PENDING", "RETRYING"] } },
    orderBy: { createdAt: "asc" },
    take: 1_000,
    select: {
      id: true,
      attemptCount: true,
      nextAttemptAt: true,
    },
  });

  let repaired = 0;
  let failed = 0;

  for (const delivery of deliveries) {
    const attemptNumber = delivery.attemptCount + 1;
    const delayMs = delivery.nextAttemptAt
      ? Math.max(0, delivery.nextAttemptAt.getTime() - Date.now())
      : 0;

    try {
      await enqueueDelivery(delivery.id, attemptNumber, delayMs);
      repaired += 1;
    } catch (error) {
      failed += 1;
      logger.warn(
        { err: error, deliveryId: delivery.id, attemptNumber },
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
