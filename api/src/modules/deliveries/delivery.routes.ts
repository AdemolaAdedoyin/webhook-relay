import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import * as deliveryService from "./delivery.service";

export const deliveryRouter = Router();

const listSchema = z.object({
  subscriptionId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
  status: z.enum(["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "RETRYING"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

deliveryRouter.get("/", async (req, res, next) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const tenantId = (req as any).tenantId as string;
    res.json(
      await deliveryService.listDeliveries(tenantId, {
        limit: parsed.data.limit,
        ...(parsed.data.eventId ? { eventId: parsed.data.eventId } : {}),
        ...(parsed.data.subscriptionId ? { subscriptionId: parsed.data.subscriptionId } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      })
    );
  } catch (err) {
    next(err);
  }
});

deliveryRouter.get("/:id", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    res.json(await deliveryService.getDelivery(tenantId, req.params.id));
  } catch (err) {
    next(err);
  }
});

deliveryRouter.post("/:id/replay", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    res.json(await deliveryService.replayDelivery(tenantId, req.params.id));
  } catch (err) {
    next(err);
  }
});
