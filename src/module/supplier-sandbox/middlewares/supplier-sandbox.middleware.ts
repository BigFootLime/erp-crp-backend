import type { RequestHandler } from "express";
import {
  supplierSandboxEnabled,
  verifySupplierSandboxSession,
} from "../domain/supplier-sandbox-security";
import { repoGetLiveSupplierSandboxAccount } from "../repository/supplier-sandbox.repository";
export const requireSupplierSandbox: RequestHandler = (_q, res, next) => {
  if (!supplierSandboxEnabled()) {
    res.status(404).json({ code: "NOT_FOUND", message: "Introuvable." });
    return;
  }
  next();
};
export const authenticateSupplierSandbox: RequestHandler = (req, res, next) => {
  const raw = req.header("authorization");
  if (!raw?.startsWith("Bearer ")) {
    res
      .status(401)
      .json({
        code: "SUPPLIER_SANDBOX_SESSION_REQUIRED",
        message: "Session fournisseur requise.",
      });
    return;
  }
  try {
    const i = verifySupplierSandboxSession(raw.slice(7));
    repoGetLiveSupplierSandboxAccount(i)
      .then((a) => {
        if (!a) {
          res
            .status(401)
            .json({
              code: "SUPPLIER_SANDBOX_SESSION_INVALID",
              message: "Session fournisseur invalide ou expirée.",
            });
          return;
        }
        req.supplierSandboxIdentity = i;
        next();
      })
      .catch(next);
  } catch (e) {
    next(e);
  }
};
