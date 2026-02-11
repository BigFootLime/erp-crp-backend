import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError.js";

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = err instanceof HttpError ? err.status : 500;

  const payload = {
    success: false,
    message: err?.message ?? "Erreur serveur.",
    code: err instanceof HttpError ? err.code : "INTERNAL_ERROR",
    path: req.originalUrl,
  };

  // logs détaillés côté serveur
  console.error("[ERROR]", {
    status,
    code: payload.code,
    message: payload.message,
    method: req.method,
    path: req.originalUrl,
    details: err?.details,
    stack: err?.stack,
  });

  res.status(status).json(payload);
}
