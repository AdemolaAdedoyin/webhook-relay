import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import * as eventService from "./event.service";

export const eventRouter = Router();

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ])
);

const publishSchema = z.object({
  type: z.string().min(1).max(120),
  payload: jsonValueSchema,
});

const idempotencyKeySchema = z.string().trim().min(1).max(200);

const listSchema = z.object({
  type: z.string().min(1).max(120).optional(),
  includeHistorical: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

eventRouter.post("/", async (req, res, next) => {
  try {
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const rawIdempotencyKey = req.get("Idempotency-Key");
    const parsedIdempotencyKey = rawIdempotencyKey
      ? idempotencyKeySchema.safeParse(rawIdempotencyKey)
      : undefined;

    if (parsedIdempotencyKey && !parsedIdempotencyKey.success) {
      throw new ValidationError({ idempotencyKey: parsedIdempotencyKey.error.flatten().formErrors });
    }

    const tenantId = (req as any).tenantId as string;
    const result = await eventService.publishEvent({
      tenantId,
      type: parsed.data.type,
      payload: parsed.data.payload,
      ...(parsedIdempotencyKey?.success
        ? { idempotencyKey: parsedIdempotencyKey.data }
        : {}),
    });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

eventRouter.get("/", async (req, res, next) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const tenantId = (req as any).tenantId as string;
    res.json(
      await eventService.listEvents(tenantId, {
        limit: parsed.data.limit,
        includeHistorical: parsed.data.includeHistorical === "true",
        ...(parsed.data.type ? { type: parsed.data.type } : {}),
      })
    );
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
