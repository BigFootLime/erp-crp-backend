import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function validationErrorMiddleware(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof ZodError) {
    const errors = err.issues.map(i => ({
      field: i.path.join("."),
      message: i.message,
    }));
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Certains champs sont invalides",
      errors,
    });
  }
  next(err);
}
