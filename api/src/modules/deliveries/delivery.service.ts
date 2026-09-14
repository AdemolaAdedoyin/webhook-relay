import { DeliveryStatus } from "@prisma/client";
import { prisma } from "../../db";
import { NotFoundError, AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { enqueueDelivery } from "../../queue/deliveryQueue";

export async function listDeliveries(
  tenantId: string,
  options: { subscriptionId?: string; status?: DeliveryStatus; limit: number }
) {
  return prisma.delivery.findMany({
    where: {
      ...(options.status ? { status: options.status } : {}),
      subscription: {
        tenantId,
        ...(options.subscriptionId ? { id: options.subscriptionId } : {}),
      },
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
    include: {
      event: { select: { id: true, type: true, createdAt: true } },
      subscription: { select: { id: true, targetUrl: true } },
    },
  });
}

export async function getDelivery(tenantId: string, id: string) {
  const delivery = await prisma.delivery.findFirst({
    where: { id, subscription: { tenantId } },
    include: {
      event: true,
      subscription: { select: { id: true, targetUrl: true, description: true } },
      attempts: { orderBy: [{ runNumber: "asc" }, { attemptNumber: "asc" }] },
    },
  });
  if (!delivery) throw new NotFoundError("Delivery", id);
  return delivery;
}

/** Manually re-trigger a terminal delivery, starting a fresh retry budget. */
export async function replayDelivery(tenantId: string, id: string) {
  const delivery = await prisma.delivery.findFirst({
    where: { id, subscription: { tenantId } },
  });
  if (!delivery) throw new NotFoundError("Delivery", id);
  if (delivery.status === "PENDING" || delivery.status === "RETRYING" || delivery.status === "PROCESSING") {
    throw new AppError("Delivery is already in flight", 409, "DELIVERY_IN_FLIGHT");
  }

  const nextRunNumber = delivery.runNumber + 1;
  const claimed = await prisma.delivery.updateMany({
    where: {
      id,
      runNumber: delivery.runNumber,
      status: delivery.status,
    },
    data: {
      runNumber: nextRunNumber,
      status: "PENDING",
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: new Date(),
      responseStatus: null,
      responseBodySnippet: null,
      errorMessage: null,
    },
  });

  if (claimed.count !== 1) {
    throw new AppError("Delivery replay raced with another operation", 409, "DELIVERY_IN_FLIGHT");
  }

  const updated = await prisma.delivery.findUniqueOrThrow({ where: { id } });

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
