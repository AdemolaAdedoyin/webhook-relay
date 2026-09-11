import { prisma } from "../../db";
import { config } from "../../config";
import { enqueueDelivery } from "../../queue/deliveryQueue";
import { NotFoundError } from "../../lib/errors";

export interface PublishEventInput {
  tenantId: string;
  type: string;
  payload: unknown;
}

/**
 * Publishing an event is the fan-out entry point: we persist the event, find
 * every ACTIVE subscription interested in this event type (an empty
 * eventTypes array means "subscribed to everything"), create one Delivery
 * row per match, and enqueue each for the worker to process.
 *
 * Event + Delivery creation happens in one transaction so we never end up
 * with an event that has no delivery attempts recorded because of a crash
 * between the two writes.
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

  await Promise.all(deliveries.map((d) => enqueueDelivery(d.id)));

  return { event, deliveryCount: deliveries.length };
}

export async function listEvents(tenantId: string, options: { type?: string; limit: number }) {
  return prisma.event.findMany({
    where: { tenantId, type: options.type },
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
