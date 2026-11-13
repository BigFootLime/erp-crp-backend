import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { stripQueryFromUrl } from "../../../utils/logPath";
import {
  hasGrantedAccountModuleAccess,
  requestHasGrantedAccountModuleAccess,
} from "../../access-control/context/account-module-access.context";
import {
  effectiveRoleHasAny,
  hasAnyAssignedRole,
  normalizeAssignedRoles,
} from "../domain/roles";
import { findAuthenticatedAccountState } from "../repository/auth.repository";
import pool from '../../../config/database';
import {sharedDirectoryClient,validateSiteDirectoryToken} from '../../../shared-directory/site-runtime';
import { enforceAuthenticatedCompany } from '../../entreprises/runtime/company-runtime.middleware';

interface JwtPayload {
  id: number;
  username: string;
  email: string;
  role: string;
  avatar_key?: string | null;
  primary_role?: string;
  roles?: string[];
  session_epoch?: number;
  mfa?: boolean;
  amr?: string[];
  mfa_verified_at?: number;
  mfa_factor_id?: string;
  mfa_factor_version?: number;
  directory_session?:string;
  directory_profile_id?:string;
  directory_global_epoch?:number;
  directory_membership_version?:number;
}

type DirectoryAuthenticationError = Error & {
  code?: unknown;
};

const rejectedDirectorySessionCodes = new Set([
  "DIRECTORY_SESSION_REQUIRED",
  "DIRECTORY_SESSION_REJECTED",
  "DIRECTORY_SESSION_STALE",
  "DIRECTORY_LOCAL_SESSION_STALE",
]);

/**
 * A directory validation failure is a rejected session only when the
 * authority says so. Local projection and database failures remain
 * availability failures: accepting the JWT would be unsafe, while returning
 * 401 would wrongly erase a valid client session.
 */
function directoryAuthenticationFailure(error: unknown): {
  status: 401 | 503;
  code: "MFA_REQUIRED" | "DIRECTORY_UNAVAILABLE";
  reason:
    | "directory_session_rejected"
    | "database_lock_timeout"
    | "database_query_timeout"
    | "directory_timeout"
    | "directory_unavailable";
} {
  const failure = error as DirectoryAuthenticationError;
  const code = typeof failure?.code === "string" ? failure.code : "";

  if (rejectedDirectorySessionCodes.has(code) || rejectedDirectorySessionCodes.has(failure?.message ?? "")) {
    return { status: 401, code: "MFA_REQUIRED", reason: "directory_session_rejected" };
  }
  if (code === "55P03") {
    return { status: 503, code: "DIRECTORY_UNAVAILABLE", reason: "database_lock_timeout" };
  }
  if (code === "57014") {
    return { status: 503, code: "DIRECTORY_UNAVAILABLE", reason: "database_query_timeout" };
  }
  if (failure?.name === "TimeoutError") {
    return { status: 503, code: "DIRECTORY_UNAVAILABLE", reason: "directory_timeout" };
  }
  return { status: 503, code: "DIRECTORY_UNAVAILABLE", reason: "directory_unavailable" };
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
    if(sharedDirectoryClient()){
      void validateSiteDirectoryToken(pool,decoded).then(identity=>{
        req.user={...decoded,username:identity.username,email:identity.email??'',role:identity.role,primary_role:identity.role,roles:identity.roles};
        enforceAuthenticatedCompany(req, res, next);
      }).catch(error=>{
        const failure = directoryAuthenticationFailure(error);
        console.warn(JSON.stringify({ type: "directory_auth_failure", reason: failure.reason, status: failure.status }));
        const unavailable = failure.status === 503;
        res.status(unavailable?503:401).json({code:unavailable?'DIRECTORY_UNAVAILABLE':'MFA_REQUIRED',message:unavailable?'L’annuaire commun est momentanément indisponible.':'Une nouvelle connexion est requise.'});
      });return;
    }
    requireActiveAccount(req, res, (error?: unknown) => {
      if (error) { next(error); return; }
      enforceAuthenticatedCompany(req, res, next);
    });
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
 * Enforce the live account lifecycle after JWT verification. The token proves
 * identity; it does not keep an inactive, blocked or suspended account alive.
 */
export const requireActiveAccount: RequestHandler = (req, res, next) => {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    res.status(401).json({ error: "Utilisateur non authentifié" });
    return;
  }

  findAuthenticatedAccountState(user.id)
    .then((state) => {
      if (!state || state.status !== "Active") {
        console.warn(
          JSON.stringify({
            type: "auth_forbidden",
            reason: "account_not_active",
            requestId: req.requestId ?? null,
            method: req.method,
            path: stripQueryFromUrl(req.originalUrl),
            userId: user.id,
          }),
        );
        res.status(403).json({ error: "Accès interdit" });
        return;
      }

      if (
        typeof user.session_epoch === "number"
        && user.session_epoch !== state.session_epoch
      ) {
        res.status(401).json({ error: "Token invalide ou expiré" });
        return;
      }
      if (state.mfa_required && (
        user.mfa !== true
        || !user.amr?.some((method) => method === "totp" || method === "recovery_code")
        || user.mfa_factor_id !== state.mfa_factor_id
        || user.mfa_factor_version !== state.mfa_factor_version
      )) {
        console.warn(JSON.stringify({
          type: "auth_forbidden",
          reason: "mfa_assurance_missing_or_stale",
          requestId: req.requestId ?? null,
          method: req.method,
          path: stripQueryFromUrl(req.originalUrl),
          userId: user.id,
        }));
        res.status(401).json({
          success: false,
          code: "MFA_REQUIRED",
          message: "Une nouvelle connexion avec authentification renforcée est requise.",
        });
        return;
      }
      next();
    })
    .catch(next);
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

    if (
      requestHasGrantedAccountModuleAccess(req) ||
      hasGrantedAccountModuleAccess()
    ) {
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
