import type { RequestHandler } from "express";
import { renewSessionToken } from "../domain/session-renewal";

export const renewSession: RequestHandler = (req, res, next) => {
  try {
    if (!req.user) { res.status(401).json({ code: "AUTH_REQUIRED" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ token: renewSessionToken(req.user) });
  } catch (error) { next(error); }
};
