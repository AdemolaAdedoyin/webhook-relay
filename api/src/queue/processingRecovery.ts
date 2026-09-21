import { prisma } from "../db";
import { config } from "../config";
import { logger } from "../lib/logger";
import { enqueueDelivery } from "./deliveryQueue";

export async function refreshProcessingLease(
  deliveryId: string,
  runNumber: number,
  attemptNumber: number
): Promise<boolean> {
  const updated = await prisma.delivery.updateMany({
    where: {
      id: deliveryId,
      runNumber,
      attemptCount: attemptNumber,
      status: "PROCESSING",
    },
    data: { processingHeartbeatAt: new Date() },
  });

  return updated.count === 1;
}

export async function recoverStaleProcessingDeliveries(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.DELIVERY_PROCESSING_STALE_MS);
  const stale = await prisma.delivery.findMany({
    where: {
      status: "PROCESSING",
      OR: [
        { processingHeartbeatAt: { lte: cutoff } },
        { processingHeartbeatAt: null, lastAttemptAt: { lte: cutoff } },
      ],
    },
    orderBy: { lastAttemptAt: "asc" },
    take: 1_000,
    select: {
      subscription: { select: { archivedAt: true } },
      id: true,
      runNumber: true,
      attemptCount: true,
      maxAttempts: true,
      processingHeartbeatAt: true,
      lastAttemptAt: true,
    },
  });

  let recovered = 0;
  let exhausted = 0;
  let projectionFailures = 0;

  for (const delivery of stale) {
    const leaseTimestamp = delivery.processingHeartbeatAt ?? delivery.lastAttemptAt;
    if (!leaseTimestamp) continue;

    if (delivery.subscription?.archivedAt || delivery.attemptCount >= delivery.maxAttempts) {
      const finalized = await prisma.delivery.updateMany({
        where: {
          id: delivery.id,
          runNumber: delivery.runNumber,
          attemptCount: delivery.attemptCount,
          status: "PROCESSING",
          processingHeartbeatAt: delivery.processingHeartbeatAt,
        },
        data: {
          status: delivery.subscription?.archivedAt ? "CANCELLED" : "FAILED",
          processingHeartbeatAt: null,
          nextAttemptAt: null,
          errorMessage: "Worker stopped before the delivery attempt could be finalized",
        },
      });

      if (finalized.count === 1) exhausted += 1;
      continue;
    }

    const released = await prisma.delivery.updateMany({
      where: {
        id: delivery.id,
        runNumber: delivery.runNumber,
        attemptCount: delivery.attemptCount,
        status: "PROCESSING",
        processingHeartbeatAt: delivery.processingHeartbeatAt,
      },
      data: {
        status: "RETRYING",
        processingHeartbeatAt: null,
        nextAttemptAt: now,
        errorMessage: "Worker stopped before the delivery attempt could be finalized",
      },
    });

    if (released.count !== 1) continue;
    recovered += 1;

    try {
      await enqueueDelivery(
        delivery.id,
        delivery.runNumber,
        delivery.attemptCount + 1,
        0
      );
    } catch (error) {
      projectionFailures += 1;
      logger.warn(
        {
          err: error,
          deliveryId: delivery.id,
          runNumber: delivery.runNumber,
          attemptNumber: delivery.attemptCount + 1,
        },
        "recovered delivery but queue projection failed; reconciliation will repair it"
      );
    }
  }

  logger.info(
    { checked: stale.length, recovered, exhausted, projectionFailures },
    "stale processing recovery completed"
  );

  return { checked: stale.length, recovered, exhausted, projectionFailures };
}
