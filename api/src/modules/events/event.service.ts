import { prisma } from "../../db";
import { config } from "../../config";
import { enqueueDelivery } from "../../queue/deliveryQueue";
import { NotFoundError } from "../../lib/errors";
import { logger } from "../../lib/logger";

export interface PublishEventInput {
  tenantId: string;
  type: string;
  payload: unknown;
}

/**
 * Publishing an event is the fan-out entry point: we persist the event, find
 * every ACTIVE subscription interested in this event type (an empty
 * eventTypes array means "subscribed to everything"), create one Delivery
 * row per match, and then project those durable deliveries into BullMQ.
 *
 * Event + Delivery creation happens in one transaction. Redis is deliberately
 * treated as a rebuildable execution layer: projection failures are logged and
 * repaired by reconciliation instead of rolling back durable state.
 */
export async function publishEvent(input: PublishEventInput) {
  const subscriptions = await prisma.subscription.findMany({
    where: {
      tenantId: input.tenantId,
      status: "ACTIVE",
    },
  });

  const matching = subscriptions.filter(
    (sub) => sub.eventTypes.length === 0 || sub.eventTypes.includes(input.type)
  );

  const { event, deliveries } = await prisma.$transaction(async (tx) => {
    const event = await tx.event.create({
      data: { tenantId: input.tenantId, type: input.type, payload: input.payload as any },
    });

    const deliveries = await Promise.all(
      matching.map((sub) =>
        tx.delivery.create({
          data: {
            eventId: event.id,
            subscriptionId: sub.id,
            maxAttempts: config.DELIVERY_MAX_ATTEMPTS,
          },
        })
      )
    );

    return { event, deliveries };
  });

  const projections = await Promise.allSettled(
    deliveries.map((delivery) => enqueueDelivery(delivery.id, 1))
  );

  projections.forEach((projection, index) => {
    if (projection.status === "rejected") {
      logger.warn(
        { err: projection.reason, deliveryId: deliveries[index]?.id, eventId: event.id },
        "delivery persisted but queue projection failed; reconciliation will repair it"
      );
    }
  });

  return { event, deliveryCount: deliveries.length };
}

export async function listEvents(tenantId: string, options: { type?: string; limit: number }) {
  return prisma.event.findMany({
    where: {
      tenantId,
      ...(options.type ? { type: options.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
    include: { _count: { select: { deliveries: true } } },
  });
}

export async function getEvent(tenantId: string, id: string) {
  const event = await prisma.event.findFirst({
    where: { id, tenantId },
    include: { deliveries: { include: { subscription: true } } },
  });
  if (!event) throw new NotFoundError("Event", id);
  return event;
}
