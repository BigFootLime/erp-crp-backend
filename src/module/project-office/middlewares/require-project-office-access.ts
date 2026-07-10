import type { NextFunction, Request, Response } from "express";
import { hasProjectOfficeAccess } from "../services/project-office-access.service";

// Gate du module Project Office (#130) — monté en tête du routeur /project-office,
// APRÈS le socle authenticateToken. Fail-closed : flag absent/OFF ⇒ 403 contrôlé.
// Le frontend ne fait que MASQUER la nav ; la sécurité réelle est ici.
export function requireProjectOfficeAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    res.status(401).json({ error: "Utilisateur non authentifié" });
    return;
  }
  hasProjectOfficeAccess(user.id)
    .then((ok) => {
      if (ok) {
        next();
        return;
      }
      console.warn(
        JSON.stringify({
          type: "auth_forbidden",
          module: "project-office",
          reason: "feature_flag_off",
          requestId: req.requestId ?? null,
          method: req.method,
          path: req.originalUrl,
          userId: user.id,
        })
      );
      // Non bavard : pas de détail sur le flag ni sur l'existence du module.
      res.status(403).json({ error: "Accès interdit" });
    })
    .catch(next);
}
