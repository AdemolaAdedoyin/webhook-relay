import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import * as eventService from "./event.service";

export const eventRouter = Router();

const publishSchema = z.object({
  type: z.string().min(1).max(120),
  payload: z.unknown(),
});

eventRouter.post("/", async (req, res, next) => {
  try {
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const tenantId = (req as any).tenantId as string;
    const result = await eventService.publishEvent({ tenantId, ...parsed.data });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

eventRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(await eventService.listEvents(tenantId, { type, limit }));
  } catch (err) {
    next(err);
  }
});

eventRouter.get("/:id", async (req, res, next) => {
  try {
    const tenantId = (req as any).tenantId as string;
    res.json(await eventService.getEvent(tenantId, req.params.id));
  } catch (err) {
    next(err);
  }
});
