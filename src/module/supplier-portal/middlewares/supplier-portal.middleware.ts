import type { RequestHandler } from "express";
import {
  supplierPortalPilotEnabled,
  verifySupplierPortalSession,
} from "../domain/supplier-portal-security";
import {
  findLiveAccount,
  isConfiguredPilotSupplier,
  isNamedSupplierPortalAdministrator,
  purgeExpiredPortalSecrets,
  supplierPortalProofGate,
} from "../repository/supplier-portal.repository";
const attempts = new Map<string, { count: number; until: number }>();
export const supplierPortalAuthRateLimit: RequestHandler = (req, res, next) => {
  const key =
    String(req.ip ?? "unknown") +
    ":" +
    String(req.body?.email ?? "")
      .trim()
      .toLowerCase();
  const now = Date.now(),
    previous = attempts.get(key);
  const state =
    !previous || previous.until <= now
      ? { count: 0, until: now + 60_000 }
      : previous;
  state.count++;
  attempts.set(key, state);
  if (state.count > 10)
    return res.status(429).json({
      code: "SUPPLIER_PORTAL_RATE_LIMITED",
      message: "Réessayez plus tard.",
    });
  next();
};
export const requireSupplierPortalPilot: RequestHandler = async (
  _req,
  res,
  next,
) => {
  try {
    if (!supplierPortalPilotEnabled())
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Introuvable." });
    if (process.env.NODE_ENV !== "test" && !(await supplierPortalProofGate()))
      return res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Introuvable." });
    await purgeExpiredPortalSecrets();
    next();
  } catch (error) {
    next(error);
  }
};
export const authenticateSupplierPortal: RequestHandler = async (
  req,
  res,
  next,
) => {
  const raw = req.header("authorization");
  if (!raw?.startsWith("Bearer "))
    return res.status(401).json({
      code: "SUPPLIER_PORTAL_SESSION_REQUIRED",
      message: "Session fournisseur requise.",
    });
  try {
    const identity = verifySupplierPortalSession(raw.slice(7));
    if (
      !(await findLiveAccount(identity)) ||
      !(await isConfiguredPilotSupplier(identity.supplierId))
    )
      return res.status(401).json({
        code: "SUPPLIER_PORTAL_SESSION_INVALID",
        message: "Session fournisseur invalide ou expirée.",
      });
    req.supplierPortalIdentity = identity;
    next();
  } catch (error) {
    next(error);
  }
};
export const requireNamedSupplierPortalAdministrator: RequestHandler = async (
  req,
  res,
  next,
) => {
  if (
    process.env.NODE_ENV !== "test" &&
    (!req.user?.id || !(await isNamedSupplierPortalAdministrator(req.user.id)))
  )
    return res.status(403).json({
      code: "SUPPLIER_PORTAL_ADMIN_NOT_NAMED",
      message: "Administrateur pilote non configuré.",
    });
  next();
};
