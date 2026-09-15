import { ErrorRequestHandler } from "express";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, requestId: req.id, path: req.path }, "unhandled app error");
    }
    res.status(err.statusCode).json({
      error: { requestId: req.id, code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  logger.error({ err, requestId: req.id, path: req.path }, "unexpected error");
  res.status(500).json({
    error: { requestId: req.id, code: "INTERNAL_ERROR", message: "Something went wrong" },
  });
};
