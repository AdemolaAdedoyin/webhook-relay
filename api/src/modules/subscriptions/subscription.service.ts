import { prisma } from "../../db";
import { generateSecret } from "../../lib/signature";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { assertWebhookUrlConfigured } from "../../lib/network";

export interface CreateSubscriptionInput {
  tenantId: string;
  targetUrl: string;
  description?: string;
  eventTypes: string[];
  maxConcurrentDeliveries?: number;
  minDeliveryIntervalMs?: number;
}

export async function createSubscription(input: CreateSubscriptionInput) {
  let targetUrl: string;
  try {
    targetUrl = assertWebhookUrlConfigured(input.targetUrl).toString();
  } catch (error) {
    throw new ValidationError({
      targetUrl: [error instanceof Error ? error.message : "Webhook target is not allowed"],
    });
  }

  const secret = generateSecret();
  const subscription = await prisma.subscription.create({
    data: {
      tenantId: input.tenantId,
      targetUrl,
      eventTypes: input.eventTypes,
      secret,
      maxConcurrentDeliveries: input.maxConcurrentDeliveries ?? 2,
      minDeliveryIntervalMs: input.minDeliveryIntervalMs ?? 0,
      ...(input.description ? { description: input.description } : {}),
    },
  });
  // The secret is only ever returned in full at creation time; subsequent
  // reads redact it (see toPublicSubscription) so it can't leak via list/get.
  const { nextDeliveryAllowedAt: _admissionClock, ...created } = subscription;
  return created;
}

export async function listSubscriptions(tenantId: string) {
  const subs = await prisma.subscription.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  return subs.map(toPublicSubscription);
}

export async function getSubscription(tenantId: string, id: string) {
  const sub = await prisma.subscription.findFirst({ where: { id, tenantId } });
  if (!sub) throw new NotFoundError("Subscription", id);
  return toPublicSubscription(sub);
}

export async function updateSubscriptionStatus(
  tenantId: string,
  id: string,
  status: "ACTIVE" | "PAUSED"
) {
  const sub = await prisma.subscription.findFirst({ where: { id, tenantId } });
  if (!sub) throw new NotFoundError("Subscription", id);

  const updated = await prisma.subscription.update({
    where: { id },
    data: { status, consecutiveFailures: status === "ACTIVE" ? 0 : sub.consecutiveFailures },
  });
  return toPublicSubscription(updated);
}

export async function deleteSubscription(tenantId: string, id: string) {
  const sub = await prisma.subscription.findFirst({ where: { id, tenantId } });
  if (!sub) throw new NotFoundError("Subscription", id);
  await prisma.subscription.delete({ where: { id } });
}

function toPublicSubscription<T extends { secret: string; nextDeliveryAllowedAt?: Date | null }>(sub: T) {
  const { secret, nextDeliveryAllowedAt: _admissionClock, ...rest } = sub;
  return { ...rest, secretPreview: `${secret.slice(0, 10)}${"*".repeat(8)}` };
}

export async function updateSubscriptionLimits(
  tenantId: string, id: string,
  limits: { maxConcurrentDeliveries?: number; minDeliveryIntervalMs?: number }
) {
  const updated = await prisma.subscription.updateMany({ where: { id, tenantId }, data: limits });
  if (updated.count !== 1) throw new NotFoundError("Subscription", id);
  return getSubscription(tenantId, id);
}
