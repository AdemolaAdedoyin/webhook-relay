import { randomBytes } from "node:crypto";
import { prisma } from "../../db";
import { protectSecret, revealSecret } from "../../lib/secretEncryption";
import { AppError, NotFoundError } from "../../lib/errors";
import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import * as subscriptionService from "./subscription.service";

export const subscriptionRouter = Router();

const createSchema = z.object({
  targetUrl: z.string().url(),
  description: z.string().max(280).optional(),
  eventTypes: z.array(z.string().min(1)).default([]),
  maxConcurrentDeliveries: z.number().int().min(1).max(100).default(2),
  minDeliveryIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
});

subscriptionRouter.post("/", async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const tenantId = (req as any).tenantId as string;
    const subscription = await subscriptionService.createSubscription({
      tenantId,
      targetUrl: parsed.data.targetUrl,
      eventTypes: parsed.data.eventTypes,
      maxConcurrentDeliveries: parsed.data.maxConcurrentDeliveries,
      minDeliveryIntervalMs: parsed.data.minDeliveryIntervalMs,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
    });
    // Full secret is only ever exposed here, at creation. Store it now.
    res.status(201).json(subscription);
  } catch (err) {
    next(err);
  }
});

subscriptionRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    res.json(await subscriptionService.listSubscriptions(tenantId));
  } catch (err) {
    next(err);
  }
});

subscriptionRouter.get("/:id", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    res.json(await subscriptionService.getSubscription(tenantId, req.params.id));
  } catch (err) {
    next(err);
  }
});

const statusSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]) });

subscriptionRouter.patch("/:id/status", async (req, res, next) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const tenantId = (req as any).tenantId as string;
    const updated = await subscriptionService.updateSubscriptionStatus(
      tenantId,
      req.params.id,
      parsed.data.status
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

subscriptionRouter.delete("/:id", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    await subscriptionService.deleteSubscription(tenantId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const limitsSchema = z.object({
  maxConcurrentDeliveries: z.number().int().min(1).max(100).optional(),
  minDeliveryIntervalMs: z.number().int().min(0).max(3_600_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one limit is required");

subscriptionRouter.patch("/:id/limits", async (req, res, next) => {
  try {
    const parsed = limitsSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const { maxConcurrentDeliveries, minDeliveryIntervalMs } = parsed.data;
    res.json(await subscriptionService.updateSubscriptionLimits((req as any).tenantId, req.params.id, {
      ...(maxConcurrentDeliveries !== undefined ? { maxConcurrentDeliveries } : {}),
      ...(minDeliveryIntervalMs !== undefined ? { minDeliveryIntervalMs } : {}),
    }));
  } catch (error) { next(error); }
});

const rotationSchema = z.object({ graceSeconds: z.number().int().min(0).max(3600).default(300) }).strict();
subscriptionRouter.post("/:id/rotate-secret", async (req, res, next) => {
  try {
    const parsed = rotationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const id = req.params.id;
    const tenantId = (req as any).tenantId as string;
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Subscription" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundError("Subscription", id);
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id } });
      const now = new Date();
      if (sub.previousSecretExpiresAt && sub.previousSecretExpiresAt > now) throw new AppError("A signing rotation is already in its grace period", 409, "ROTATION_IN_PROGRESS");
      const previousSecretExpiresAt = parsed.data.graceSeconds ? new Date(now.getTime() + parsed.data.graceSeconds * 1000) : null;
      await tx.subscription.update({ where: { id }, data: {
        secret: protectSecret(secret, id),
        previousSecret: previousSecretExpiresAt ? protectSecret(revealSecret(sub.secret, id), id) : null,
        previousSecretExpiresAt,
      } });
      return { id, secret, previousSecretExpiresAt };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) { next(error); }
});
