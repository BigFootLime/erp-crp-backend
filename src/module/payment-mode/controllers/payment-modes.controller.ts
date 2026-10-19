// src/module/payment-modes/controllers/payment-modes.controller.ts
import type { RequestHandler } from "express";
import { svcCreatePaymentMode, svcListPaymentModes } from "../services/payment-modes.service";
import { createPaymentModeSchema } from "../validators/payment-mode.validators";
import { HttpError } from "../../../utils/httpError";

export const postPaymentMode: RequestHandler = async (req, res, next) => {
  try {
    const parsed = createPaymentModeSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "PAYMENT_MODE_INPUT_INVALID", "Mode de règlement invalide.");
    const { name, code, notes } = parsed.data;

    const createdBy =
      req.user?.username ??
      req.user?.email ??
      (typeof req.user?.id === "number" ? String(req.user.id) : null);

    const row = await svcCreatePaymentMode({ name, code, notes, createdBy });
    res.status(201).json(row);
  } catch (error) { next(error); }
};

export const listPaymentModes: RequestHandler = async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const rows = await svcListPaymentModes(q);
    res.json(rows);
  } catch (error) { next(error); }
};
