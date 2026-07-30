import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { stripQueryFromUrl } from "../../../utils/logPath";
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import {
  effectiveRoleHasAny,
  hasAnyAssignedRole,
  normalizeAssignedRoles,
} from "../domain/roles";

interface JwtPayload {
  id: number;
  username: string;
  email: string;
  role: string;
  primary_role?: string;
  roles?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const authenticateToken: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const ctx = {
    requestId: req.requestId ?? null,
    origin: req.headers.origin ?? null,
    method: req.method,
    path: stripQueryFromUrl(req.originalUrl),
  };

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.warn(JSON.stringify({ type: "auth_fail", reason: "missing_bearer", ...ctx }));
    res.status(401).json({ error: "Token manquant ou invalide" });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
    req.user = decoded;
    next();
  } catch (err) {
    console.warn(
      JSON.stringify({
        type: "auth_fail",
        reason: "jwt_verify_failed",
        error: err instanceof Error ? err.name : "unknown",
        ...ctx,
      })
    );
    res.status(401).json({ error: "Token invalide ou expiré" });
  }
};

/**
 * Compatibility wrapper kept for existing routes.
 *
 * Roles are descriptive metadata only. Authenticated business access is
 * resolved per account and per module by moduleAccessGate. The Access Control
 * Tower does not use this wrapper: requireSuperadmin checks the database
 * account flag independently.
 */
export const authorizeRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      console.warn(
        JSON.stringify({
          type: "auth_fail",
          reason: "missing_user",
          requestId: req.requestId ?? null,
          origin: req.headers.origin ?? null,
          method: req.method,
          path: stripQueryFromUrl(req.originalUrl),
        })
      );
      res.status(401).json({ error: "Utilisateur non authentifié" });
      return;
    }

    if (hasGrantedAccountModuleAccess()) {
      next();
      return;
    }

    const primaryRole = req.user.primary_role ?? req.user.role;
    const assignedRoles = normalizeAssignedRoles(primaryRole, req.user.roles);
    const hasAssignedMatch = hasAnyAssignedRole(primaryRole, assignedRoles, roles);
    const hasEffectiveMatch = effectiveRoleHasAny(req.user.role, roles);
    if (!hasAssignedMatch && !hasEffectiveMatch) {
      console.warn(
        JSON.stringify({
          type: "auth_forbidden",
          requestId: req.requestId ?? null,
          origin: req.headers.origin ?? null,
          method: req.method,
          path: stripQueryFromUrl(req.originalUrl),
          userId: req.user.id,
          role: primaryRole,
          roles: assignedRoles,
          allowedRoles: roles,
        })
      );
      res.status(403).json({ error: "Accès interdit" });
      return;
    }

    next();
  };
};
