// src/module/payment-modes/controllers/payment-modes.controller.ts
import type { RequestHandler } from "express";
import { svcCreatePaymentMode, svcListPaymentModes } from "../services/payment-modes.service";

export const postPaymentMode: RequestHandler = async (req, res) => {
  try {
    const { name, code, notes } = req.body as { name: string; code?: string; notes?: string };
    if (!name?.trim()) {
      res.status(400).send("name requis");
      return;
    }

    const createdBy =
      req.user?.username ??
      req.user?.email ??
      (typeof req.user?.id === "number" ? String(req.user.id) : null);

    const row = await svcCreatePaymentMode({ name, code, notes, createdBy });
    res.status(201).json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erreur création mode";
    res.status(500).send(msg);
  }
};

export const listPaymentModes: RequestHandler = async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const rows = await svcListPaymentModes(q);
    res.json(rows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erreur liste modes";
    res.status(500).send(msg);
  }
};
