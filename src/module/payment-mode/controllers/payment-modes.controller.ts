import { Request, Response } from "express";
import { createPaymentModeSchema } from "../validators/payment-mode.validators";
import { createPaymentMode, listPaymentModes } from "../services/payment-modes.service";

export async function getPaymentModes(req: Request, res: Response) {
  const data = await listPaymentModes();
  res.json(data);
}

export async function postPaymentMode(req: Request, res: Response) {
  const parsed = createPaymentModeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
  }
  const data = await createPaymentMode(parsed.data);
  res.status(201).json(data);
}
