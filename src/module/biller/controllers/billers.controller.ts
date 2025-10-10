// src/module/billers/controllers/billers.controller.ts
import { RequestHandler } from "express";
import { svcListBillers } from "../services/billers.service";

export const listBillers: RequestHandler = async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    res.json(await svcListBillers(q));
  } catch (e) {
    next(e);
  }
};
