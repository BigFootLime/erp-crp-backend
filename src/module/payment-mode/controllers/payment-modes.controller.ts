// src/module/payment-modes/controllers/payment-modes.controller.ts
import { Request, Response } from "express";
import { svcCreatePaymentMode, svcListPaymentModes } from "../services/payment-modes.service";

export async function postPaymentMode(req: Request, res: Response) {
  try {
    const { name, code, notes } = req.body as { name: string; code?: string; notes?: string };
    if (!name?.trim()) return res.status(400).send("name requis");

    const createdBy =
      (req as any).user?.username ??
      (req as any).user?.email ??
      (req as any).user?.id ??
      null;

    const row = await svcCreatePaymentMode({ name, code, notes, createdBy });
    return res.status(201).json(row);
  } catch (e: any) {
    return res.status(500).send(e?.message ?? "Erreur création mode");
  }
}

export async function listPaymentModes(req: Request, res: Response) {
  try {
    const q = (req.query.q as string) ?? "";
    const rows = await svcListPaymentModes(q);
    return res.json(rows);
  } catch (e: any) {
    return res.status(500).send(e?.message ?? "Erreur liste modes");
  }
}
