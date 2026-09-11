import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import * as subscriptionService from "./subscription.service";

export const subscriptionRouter = Router();

const createSchema = z.object({
  targetUrl: z.string().url(),
  description: z.string().max(280).optional(),
  eventTypes: z.array(z.string().min(1)).default([]),
});

subscriptionRouter.post("/", async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const tenantId = (req as any).tenantId as string;
    const subscription = await subscriptionService.createSubscription({ tenantId, ...parsed.data });
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
