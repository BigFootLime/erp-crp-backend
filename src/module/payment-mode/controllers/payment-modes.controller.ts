// src/module/payment-modes/controllers/payment-modes.controller.ts
import { RequestHandler } from "express";
import { svcCreatePaymentMode, svcListPaymentModes } from "../services/payment-modes.service";

export const postPaymentMode: RequestHandler = async (req, res, next) => {
  try {
    const created = await svcCreatePaymentMode(req.body);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
};

export const listPaymentModes: RequestHandler = async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    const rows = await svcListPaymentModes(q);
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
