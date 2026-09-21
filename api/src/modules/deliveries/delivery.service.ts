import { DeliveryStatus } from "@prisma/client";
import { config } from "../../config";
import { prisma } from "../../db";
import { NotFoundError, AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { enqueueDelivery } from "../../queue/deliveryQueue";

export async function listDeliveries(
  tenantId: string,
  options: { subscriptionId?: string; eventId?: string; status?: DeliveryStatus[]; limit: number }
) {
  return prisma.delivery.findMany({
    where: {
      ...(options.eventId ? { eventId: options.eventId } : {}),
      ...(options.status ? { status: { in: options.status } } : {}),
      subscription: {
        tenantId,
        ...(options.subscriptionId ? { id: options.subscriptionId } : {}),
      },
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
    include: {
      event: { select: { id: true, type: true, createdAt: true } },
      subscription: { select: { id: true, targetUrl: true, archivedAt: true, status: true } },
    },
  });
}

export async function getDelivery(tenantId: string, id: string) {
  const delivery = await prisma.delivery.findFirst({
    where: { id, subscription: { tenantId } },
    include: {
      event: true,
      subscription: { select: { id: true, targetUrl: true, archivedAt: true, status: true, description: true } },
      attempts: { orderBy: [{ runNumber: "asc" }, { attemptNumber: "asc" }] },
    },
  });
  if (!delivery) throw new NotFoundError("Delivery", id);
  return { ...delivery, maxReplays: config.DELIVERY_MAX_REPLAYS, replaysUsed: delivery.runNumber - 1 };
}

/** Manually re-trigger a terminal delivery, starting a fresh retry budget. */
export async function replayDelivery(tenantId: string, id: string) {
  const updated = await prisma.$transaction(async (tx) => {
    const found = await tx.delivery.findFirst({ where: { id, subscription: { tenantId } } });
    if (!found) throw new NotFoundError("Delivery", id);
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${found.subscriptionId} FOR UPDATE`;
    const delivery = await tx.delivery.findFirst({ where: { id, subscription: { tenantId } }, include: { subscription: true } });
    if (!delivery) throw new NotFoundError("Delivery", id);
    if (delivery.subscription.archivedAt || delivery.status === "CANCELLED") throw new AppError("Archived or cancelled delivery cannot be replayed", 409, "DELIVERY_ARCHIVED");
    if (!["SUCCEEDED", "FAILED"].includes(delivery.status)) throw new AppError("Delivery is already in flight", 409, "DELIVERY_IN_FLIGHT");
    if (delivery.runNumber - 1 >= config.DELIVERY_MAX_REPLAYS) throw new AppError("Manual replay limit reached", 409, "REPLAY_LIMIT_REACHED");
    const claimed = await tx.delivery.updateMany({
      where: { id, runNumber: delivery.runNumber, status: delivery.status },
      data: { runNumber: delivery.runNumber + 1, status: "PENDING", attemptCount: 0,
        lastAttemptAt: null, nextAttemptAt: new Date(), responseStatus: null,
        responseBodySnippet: null, errorMessage: null },
    });
    if (claimed.count !== 1) throw new AppError("Delivery replay raced with another operation", 409, "DELIVERY_IN_FLIGHT");
    return tx.delivery.findUniqueOrThrow({ where: { id } });
  });
  const nextRunNumber = updated.runNumber;

  try {
    await enqueueDelivery(id, nextRunNumber, 1);
  } catch (error) {
    logger.warn(
      { err: error, deliveryId: id, runNumber: nextRunNumber },
      "replay persisted but queue projection failed; reconciliation will repair it"
    );
  }

  return updated;
}
