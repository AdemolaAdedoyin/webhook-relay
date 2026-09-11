import { Router } from "express";
import * as deliveryService from "./delivery.service";

export const deliveryRouter = Router();

deliveryRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(await deliveryService.listDeliveries(tenantId, { subscriptionId, status, limit }));
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
