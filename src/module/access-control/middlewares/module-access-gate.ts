import type { NextFunction, Request, Response } from "express";

import { stripQueryFromUrl } from "../../../utils/logPath";
import { grantAccountModuleAccessToRequest } from "../context/account-module-access.context";
import { isProtectedModuleKey, resolveModuleAccessKeysForRequest } from "../domain/module-catalog";
import { resolveAccessProfile } from "../services/access-control.service";

const KILL_SWITCH_ENV = "CERP_MODULE_ACCESS_GATE_DISABLED";

function isGateDisabled(): boolean {
  return process.env[KILL_SWITCH_ENV] === "1";
}

function normalizeUserId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

let killSwitchWarned = false;

function warnKillSwitchOnce(): void {
  if (killSwitchWarned) return;
  killSwitchWarned = true;
  console.warn(
    JSON.stringify({
      type: "module_access_gate_disabled",
      reason: "kill_switch",
      env: KILL_SWITCH_ENV,
    })
  );
}

if (isGateDisabled()) warnKillSwitchOnce();

// L'infrastructure d'accès est une dépendance d'autorisation : son indisponibilité
// ne doit jamais ouvrir une surface métier.
let infrastructureWarned = false;

function warnMissingInfrastructure(reason: string, moduleKey: string | null): void {
  if (infrastructureWarned) return;
  infrastructureWarned = true;
  console.warn(
    JSON.stringify({
      type: "module_access_gate_unavailable",
      reason,
      module: moduleKey,
    })
  );
}

/**
 * Gate d'accès module (#326) — monté globalement dans v1.routes.ts juste après
 * `authenticateToken` et avant le premier module métier.
 *
 * Le chemin est résolu vers un module par le catalogue TypeScript (plus long
 * préfixe, frontière de segment) ; seule la DÉCISION vient de la base. Surface
 * hors catalogue passe sans aucune requête. Les modules protégés sont résolus
 * comme les autres afin d'installer le contexte de capacités ; ils restent
 * toujours ouverts et non restreignables.
 */
export function moduleAccessGate(req: Request, res: Response, next: NextFunction): void {
  const userId = normalizeUserId(req.user?.id);
  if (userId === null) {
    // Le socle authenticateToken a déjà statué : rien à ajouter ici.
    next();
    return;
  }

  const moduleKeys =
    resolveModuleAccessKeysForRequest(req.originalUrl, req.method) ??
    resolveModuleAccessKeysForRequest(req.path, req.method);
  if (!moduleKeys) {
    // The module gate never turns a shared dependency into an authorization.
    // Its route-specific guard remains the only authority for these paths.
    next();
    return;
  }

  // Protected administration retains its own SuperAdmin and recent-MFA guards.
  // Do not install a grant here: legacy guards must not read it as a bypass.
  if (moduleKeys.some(isProtectedModuleKey)) {
    next();
    return;
  }
  if (isGateDisabled()) {
    warnKillSwitchOnce();
    // Le kill-switch désactive seulement les refus nominatifs. Il ne doit
    // jamais réactiver les anciens refus par rôle dans la suite de la requête.
    grantAccountModuleAccessToRequest(req, { userId, moduleKey: moduleKeys[0]!, elevated: true }, next);
    return;
  }

  resolveAccessProfile(userId)
    .then((profile) => {
      if (profile === null) {
        warnMissingInfrastructure("access_tables_missing", moduleKeys.join(","));
        res.status(503).json({ error: "Contrôle d'accès indisponible" });
        return;
      }
      if (profile.is_superadmin) {
        grantAccountModuleAccessToRequest(req, { userId, moduleKey: moduleKeys[0]!, elevated: true }, next);
        return;
      }

      const decisions = moduleKeys.map((moduleKey) =>
        profile.modules.find((entry) => entry.module_key === moduleKey)
      );
      if (decisions.some((decision) => !decision)) {
        // A new path is never implicitly opened while its catalogue decision is
        // absent.  Protected surfaces remain reachable only to superadmins.
        warnMissingInfrastructure("module_absent_from_catalog", moduleKeys.join(","));
        res.status(503).json({ error: "Contrôle d'accès indisponible" });
        return;
      }
      const decision = decisions.find((candidate) => candidate?.allowed === true);
      if (decision?.allowed) {
        grantAccountModuleAccessToRequest(req, {
          userId,
          moduleKey: decision.module_key,
          elevated: decision.source === "OVERRIDE" || decision.source === "SUPERADMIN",
        }, next);
        return;
      }

      console.warn(
        JSON.stringify({
          type: "auth_forbidden",
          module: moduleKeys.join(","),
          reason: "module_access_denied",
          userId,
          requestId: req.requestId ?? null,
          method: req.method,
          path: stripQueryFromUrl(req.originalUrl),
        })
      );
      // Non bavard : aucune mention du module ni de l'existence d'un filtrage.
      res.status(403).json({ error: "Accès interdit" });
    })
    .catch(next);
}
