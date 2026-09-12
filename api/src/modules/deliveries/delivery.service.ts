import { DeliveryStatus } from "@prisma/client";
import { prisma } from "../../db";
import { NotFoundError, AppError } from "../../lib/errors";
import { enqueueDelivery } from "../../queue/deliveryQueue";

export async function listDeliveries(
  tenantId: string,
  options: { subscriptionId?: string; status?: DeliveryStatus; limit: number }
) {
  return prisma.delivery.findMany({
    where: {
      status: options.status,
      subscription: { tenantId, id: options.subscriptionId },
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
      attempts: { orderBy: { attemptNumber: "asc" } },
    },
  });
  if (!delivery) throw new NotFoundError("Delivery", id);
  return delivery;
}

/** Manually re-trigger a delivery, e.g. after the receiving endpoint was fixed. */
export async function replayDelivery(tenantId: string, id: string) {
  const delivery = await prisma.delivery.findFirst({
    where: { id, subscription: { tenantId } },
  });
  if (!delivery) throw new NotFoundError("Delivery", id);
  if (delivery.status === "PENDING" || delivery.status === "RETRYING") {
    throw new AppError("Delivery is already in flight", 409, "DELIVERY_IN_FLIGHT");
  }

  const updated = await prisma.delivery.update({
    where: { id },
    data: { status: "PENDING", nextAttemptAt: new Date() },
  });
  await enqueueDelivery(id);
  return updated;
}
