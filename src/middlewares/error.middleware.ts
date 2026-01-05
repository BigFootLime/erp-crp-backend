import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/apiError";

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
    });
  }

  console.error("❌ Unhandled error:", err);
  return res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "Erreur interne du serveur",
  });
}
