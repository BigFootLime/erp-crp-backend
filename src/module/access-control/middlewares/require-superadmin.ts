import type { NextFunction, Request, Response } from "express";

import { stripQueryFromUrl } from "../../../utils/logPath";
import { isSuperadmin } from "../services/access-control.service";

// Garde de la tour de contrôle des accès (#326) — monté en tête du routeur
// /admin/access, APRÈS le socle authenticateToken. La décision vient de la base
// (users.is_superadmin), jamais du JWT : révoquer le statut prend effet tout de suite.
// Fail-closed : toute erreur de résolution refuse au lieu de laisser passer.
export function requireSuperadmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    res.status(401).json({ error: "Utilisateur non authentifié" });
    return;
  }

  const deny = (reason: string): void => {
    console.warn(
      JSON.stringify({
        type: "auth_forbidden",
        module: "access-control",
        reason,
        requestId: req.requestId ?? null,
        method: req.method,
        path: stripQueryFromUrl(req.originalUrl),
        userId: user.id,
      })
    );
    // Non bavard : ni le motif, ni l'existence de la surface ne sont révélés.
    res.status(403).json({ error: "Accès interdit" });
  };

  isSuperadmin(user.id)
    .then((ok) => {
      if (ok) {
        next();
        return;
      }
      deny("not_superadmin");
    })
    .catch(() => deny("superadmin_resolution_failed"));
}
