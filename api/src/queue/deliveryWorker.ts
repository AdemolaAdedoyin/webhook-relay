import { Worker, Job } from "bullmq";
import { prisma } from "../db";
import { config } from "../config";
import { logger } from "../lib/logger";
import { signPayload } from "../lib/signature";
import { redisConnection } from "./connection";
import { DELIVERY_QUEUE_NAME, DeliveryJobData, computeBackoffMs, enqueueDelivery } from "./deliveryQueue";

const MAX_RESPONSE_SNIPPET = 2000;

/**
 * Performs one delivery attempt: loads the delivery + its event/subscription,
 * POSTs the signed payload, records the outcome, and either marks the
 * delivery SUCCEEDED, schedules the next retry, or exhausts it as FAILED.
 *
 * Every attempt (success or failure) is written to DeliveryAttempt so the
 * dashboard can show a full timeline, not just the latest status.
 */
async function processDelivery(job: Job<DeliveryJobData>) {
  const { deliveryId } = job.data;

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { event: true, subscription: true },
  });

  if (!delivery) {
    logger.warn({ deliveryId }, "delivery not found, skipping (likely deleted)");
    return;
  }

  if (delivery.subscription.status !== "ACTIVE") {
    logger.info({ deliveryId }, "subscription no longer active, skipping delivery");
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "FAILED", errorMessage: "Subscription paused or disabled" },
    });
    return;
  }

  const attemptNumber = delivery.attemptCount + 1;
  const rawBody = JSON.stringify({
    id: delivery.event.id,
    type: delivery.event.type,
    createdAt: delivery.event.createdAt,
    data: delivery.event.payload,
  });
  const signature = signPayload(rawBody, delivery.subscription.secret);

  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let responseBodySnippet: string | null = null;
  let errorMessage: string | null = null;
  let succeeded = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.DELIVERY_TIMEOUT_MS);

    const res = await fetch(delivery.subscription.targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Webhook-Signature": signature,
        "Webhook-Event-Type": delivery.event.type,
        "Webhook-Delivery-Id": delivery.id,
        "User-Agent": "webhook-relay/1.0",
      },
      body: rawBody,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    responseStatus = res.status;
    const text = await res.text().catch(() => "");
    responseBodySnippet = text.slice(0, MAX_RESPONSE_SNIPPET);
    succeeded = res.status >= 200 && res.status < 300;
    if (!succeeded) {
      errorMessage = `Endpoint responded with HTTP ${res.status}`;
    }
  } catch (err: any) {
    errorMessage = err?.name === "AbortError" ? "Request timed out" : err?.message ?? "Unknown network error";
  }

  const durationMs = Date.now() - startedAt;

  await prisma.deliveryAttempt.create({
    data: {
      deliveryId: delivery.id,
      attemptNumber,
      durationMs,
      responseStatus,
      responseBodySnippet,
      errorMessage,
    },
  });

  if (succeeded) {
    await prisma.$transaction([
      prisma.delivery.update({
        where: { id: delivery.id },
        data: {
          status: "SUCCEEDED",
          attemptCount: attemptNumber,
          lastAttemptAt: new Date(),
          responseStatus,
          responseBodySnippet,
          errorMessage: null,
        },
      }),
      prisma.subscription.update({
        where: { id: delivery.subscriptionId },
        data: { consecutiveFailures: 0 },
      }),
    ]);
    logger.info({ deliveryId, attemptNumber, durationMs }, "delivery succeeded");
    return;
  }

  const exhausted = attemptNumber >= delivery.maxAttempts;

  if (exhausted) {
    const failures = delivery.subscription.consecutiveFailures + 1;
    const shouldDisable = failures >= config.SUBSCRIPTION_AUTO_DISABLE_THRESHOLD;

    await prisma.$transaction([
      prisma.delivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          attemptCount: attemptNumber,
          lastAttemptAt: new Date(),
          responseStatus,
          responseBodySnippet,
          errorMessage,
        },
      }),
      prisma.subscription.update({
        where: { id: delivery.subscriptionId },
        data: {
          consecutiveFailures: failures,
          ...(shouldDisable ? { status: "DISABLED" as const } : {}),
        },
      }),
    ]);
    logger.warn({ deliveryId, attemptNumber, shouldDisable }, "delivery exhausted all attempts");
    return;
  }

  const delay = computeBackoffMs(attemptNumber);
  const nextAttemptAt = new Date(Date.now() + delay);

  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      status: "RETRYING",
      attemptCount: attemptNumber,
      lastAttemptAt: new Date(),
      nextAttemptAt,
      responseStatus,
      responseBodySnippet,
      errorMessage,
    },
  });

  await enqueueDelivery(delivery.id, delay);
  logger.info({ deliveryId, attemptNumber, nextAttemptAt }, "delivery scheduled for retry");
}

export const deliveryWorker = new Worker<DeliveryJobData>(DELIVERY_QUEUE_NAME, processDelivery, {
  connection: redisConnection,
  concurrency: config.DELIVERY_CONCURRENCY,
});

deliveryWorker.on("failed", (job, err) => {
  // This fires only for unexpected exceptions in processDelivery itself
  // (e.g. a DB outage) — business-logic failures are handled above and
  // never throw, so the job always resolves.
  logger.error({ jobId: job?.id, err }, "delivery job threw unexpectedly");
});

logger.info("delivery worker started");
