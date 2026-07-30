import type { NextFunction, Request, Response } from "express";

import { stripQueryFromUrl } from "../../../utils/logPath";
import { runWithAccountModuleAccess } from "../context/account-module-access.context";
import { resolveModuleKeyForPath } from "../domain/module-catalog";
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

// Une base sans le patch #326 ne doit pas briquer l'ERP entier : on laisse passer
// et on le dit, une seule fois par processus pour ne pas noyer les journaux.
let infrastructureWarned = false;

function warnMissingInfrastructure(reason: string, moduleKey: string | null): void {
  if (infrastructureWarned) return;
  infrastructureWarned = true;
  console.warn(
    JSON.stringify({
      type: "module_access_gate_open",
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

  const moduleKey =
    resolveModuleKeyForPath(req.originalUrl) ??
    resolveModuleKeyForPath(req.path);
  if (!moduleKey) {
    // Les surfaces partagées authentifiées (utilisateurs, codes,
    // notifications, capabilities…) ne sont pas restrictibles par module.
    runWithAccountModuleAccess({ userId, moduleKey: "shared" }, next);
    return;
  }

  if (isGateDisabled()) {
    warnKillSwitchOnce();
    // Le kill-switch désactive seulement les refus nominatifs. Il ne doit
    // jamais réactiver les anciens refus par rôle dans la suite de la requête.
    runWithAccountModuleAccess({ userId, moduleKey }, next);
    return;
  }

  resolveAccessProfile(userId)
    .then((profile) => {
      if (profile === null) {
        warnMissingInfrastructure("access_tables_missing", moduleKey);
        next();
        return;
      }
      if (profile.is_superadmin) {
        runWithAccountModuleAccess({ userId, moduleKey }, next);
        return;
      }

      const decision = profile.modules.find((entry) => entry.module_key === moduleKey);
      if (!decision) {
        // Le module existe dans le code mais pas dans le catalogue de la base :
        // même famille que l'absence de tables, on ne fabrique pas un refus.
        warnMissingInfrastructure("module_absent_from_catalog", moduleKey);
        next();
        return;
      }
      if (decision.allowed) {
        runWithAccountModuleAccess({ userId, moduleKey }, next);
        return;
      }

      console.warn(
        JSON.stringify({
          type: "auth_forbidden",
          module: moduleKey,
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
