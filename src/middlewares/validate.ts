import type { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";
import { HttpError } from "../utils/httpError";

export const validateBody = (schema: ZodSchema) => (req: Request, _res: Response, next: NextFunction) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return next(new HttpError(400, "VALIDATION_ERROR", "Champs invalides.", parsed.error.flatten()));
  }
  req.body = parsed.data;
  next();
};
