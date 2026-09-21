import { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { config } from "../../config";
import { enqueueDelivery } from "../../queue/deliveryQueue";
import { IdempotencyConflictError, NotFoundError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { fingerprintEventRequest } from "../../lib/idempotency";

export interface PublishEventInput {
  tenantId: string;
  type: string;
  payload: unknown;
  idempotencyKey?: string;
}

function assertMatchingFingerprint(existingFingerprint: string | null, fingerprint: string) {
  if (existingFingerprint !== fingerprint) {
    throw new IdempotencyConflictError();
  }
}

function toPublicEvent<T extends { idempotencyFingerprint: string | null }>(event: T) {
  const { idempotencyFingerprint: _internalFingerprint, ...publicEvent } = event;
  return publicEvent;
}

async function findIdempotentEvent(tenantId: string, idempotencyKey: string) {
  return prisma.event.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId,
        idempotencyKey,
      },
    },
    include: {
      _count: { select: { deliveries: true } },
    },
  });
}

function formatIdempotentReplay(
  existing: NonNullable<Awaited<ReturnType<typeof findIdempotentEvent>>>
) {
  const { _count, ...event } = existing;
  return {
    event: toPublicEvent(event),
    deliveryCount: _count.deliveries,
    idempotentReplay: true,
  };
}

/**
 * Publishing an event is the fan-out entry point: we persist the event, find
 * every ACTIVE or PAUSED subscription interested in this event type (an empty
 * eventTypes array means "subscribed to everything"), create one Delivery
 * row per match, and then project those durable deliveries into BullMQ.
 *
 * Event + Delivery creation happens in one transaction. Redis is deliberately
 * treated as a rebuildable execution layer: projection failures are logged and
 * repaired by reconciliation instead of rolling back durable state.
 *
 * When an idempotency key is supplied, the key is unique per tenant and bound
 * to a stable fingerprint of the event type + JSON payload. Reusing the same
 * key for different work returns 409 instead of silently accepting ambiguity.
 */
export async function publishEvent(input: PublishEventInput) {
  const fingerprint = input.idempotencyKey
    ? fingerprintEventRequest(input.type, input.payload)
    : undefined;

  if (input.idempotencyKey && fingerprint) {
    const existing = await findIdempotentEvent(input.tenantId, input.idempotencyKey);
    if (existing) {
      assertMatchingFingerprint(existing.idempotencyFingerprint, fingerprint);
      return formatIdempotentReplay(existing);
    }
  }

  let committed: {
    event: Awaited<ReturnType<typeof prisma.event.create>>;
    deliveries: Array<{ id: string }>;
  };

  try {
    committed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${input.tenantId} FOR UPDATE`;
      const subscriptions = await tx.subscription.findMany({
        where: {
          tenantId: input.tenantId,
          archivedAt: null,
          status: { in: ["ACTIVE", "PAUSED"] },
        },
      });

      const matching = subscriptions.filter(
        (sub) => sub.eventTypes.length === 0 || sub.eventTypes.includes(input.type)
      );

      const event = await tx.event.create({
        data: {
          tenantId: input.tenantId,
          type: input.type,
          payload: input.payload as Prisma.InputJsonValue,
          ...(input.idempotencyKey && fingerprint
            ? {
                idempotencyKey: input.idempotencyKey,
                idempotencyFingerprint: fingerprint,
              }
            : {}),
        },
      });

      const deliveries = await Promise.all(
        matching.map((sub) =>
          tx.delivery.create({
            data: {
              eventId: event.id,
              subscriptionId: sub.id,
              maxAttempts: config.DELIVERY_MAX_ATTEMPTS,
            },
            select: { id: true },
          })
        )
      );

      return { event, deliveries };
    });
  } catch (error) {
    if (
      input.idempotencyKey &&
      fingerprint &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await findIdempotentEvent(input.tenantId, input.idempotencyKey);
      if (winner) {
        assertMatchingFingerprint(winner.idempotencyFingerprint, fingerprint);
        return formatIdempotentReplay(winner);
      }
    }

    throw error;
  }

  const { event, deliveries } = committed;
  const projections = await Promise.allSettled(
    deliveries.map((delivery) => enqueueDelivery(delivery.id, 1, 1))
  );

  projections.forEach((projection, index) => {
    if (projection.status === "rejected") {
      logger.warn(
        { err: projection.reason, deliveryId: deliveries[index]?.id, eventId: event.id },
        "delivery persisted but queue projection failed; reconciliation will repair it"
      );
    }
  });

  return {
    event: toPublicEvent(event),
    deliveryCount: deliveries.length,
    idempotentReplay: false,
  };
}

export async function listEvents(tenantId: string, options: { type?: string; limit: number; includeHistorical?: boolean }) {
  const events = await prisma.event.findMany({
    where: {
      tenantId,
      ...(!options.includeHistorical ? { OR: [
        { deliveries: { none: {} } },
        { deliveries: { some: { subscription: { archivedAt: null } } } },
      ] } : {}),
      ...(options.type ? { type: options.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
    include: { _count: { select: { deliveries: true } }, deliveries: { select: { subscription: { select: { archivedAt: true } } } } },
  });

  return events.map(({ deliveries, ...event }) => ({ ...toPublicEvent(event), historical: deliveries.length > 0 && deliveries.every(d => d.subscription.archivedAt !== null) }));
}

export async function getEvent(tenantId: string, id: string) {
  const event = await prisma.event.findFirst({
    where: { id, tenantId },
    include: { deliveries: { include: { subscription: { select: { id: true, targetUrl: true, description: true, archivedAt: true, status: true } } } } },
  });
  if (!event) throw new NotFoundError("Event", id);
  return { ...toPublicEvent(event), historical: event.deliveries.length > 0 && event.deliveries.every(d => d.subscription.archivedAt !== null) };
}
