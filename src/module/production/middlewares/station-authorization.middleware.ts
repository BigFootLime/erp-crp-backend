import type { RequestHandler, Request, Response } from "express";

import { HttpError } from "../../../utils/httpError";
import {
  evaluateSession,
  roleHasStationCapability,
  type StationCapability,
} from "../domain/station";
import {
  repoFindSessionByToken,
  repoSetSessionState,
  repoStationAudit,
  repoTouchSession,
} from "../repository/station.repository";

/**
 * Contexte de poste attaché à la requête. Il est la SEULE source d'identité du
 * module : aucune route ne lit un `user_id` dans le corps de la requête.
 */
export type StationContext = {
  session_id: string;
  device_id: string;
  device_code: string;
  device_zone: string | null;
  device_assignment_mode: "FIXED" | "MOBILE";
  machine_id: string | null;
  user: { id: number; username: string; name: string | null; surname: string | null; role: string | null };
  auto_lock_seconds: number;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      station?: StationContext;
    }
  }
}

export const STATION_SESSION_COOKIE = "cerp_station_session";
export const STATION_SESSION_HEADER = "x-station-session";

/**
 * Récupère le jeton de session opaque.
 *
 * Le cookie `httpOnly` est la voie NORMALE : il n'est pas lisible par le
 * JavaScript de la page, donc une faille XSS ne l'exfiltre pas. L'en-tête reste
 * accepté en repli parce que certaines configurations de proxy suppriment les
 * cookies tiers ; dans ce cas le jeton vit en mémoire de l'onglet et n'est
 * jamais écrit dans `localStorage`.
 */
export function readStationToken(req: Request): string | null {
  const rawCookie = req.headers.cookie;
  if (typeof rawCookie === "string" && rawCookie.length > 0) {
    for (const part of rawCookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === STATION_SESSION_COOKIE && rest.length) {
        const value = decodeURIComponent(rest.join("="));
        if (value) return value;
      }
    }
  }
  const header = req.headers[STATION_SESSION_HEADER];
  if (typeof header === "string" && header.trim()) return header.trim();
  return null;
}

/** Pose le cookie de session. `SameSite=None` est requis : l'API et l'UI sont sur deux origines. */
export function setStationSessionCookie(res: Response, token: string, maxAgeSeconds: number): void {
  res.cookie(STATION_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearStationSessionCookie(res: Response): void {
  res.clearCookie(STATION_SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
}

/**
 * Exige une session de poste vivante.
 *
 * Contrairement à un JWT, cette vérification interroge la base à chaque
 * requête : c'est ce qui rend la révocation d'une tablette IMMÉDIATE. Le coût
 * d'un aller-retour est le prix d'une révocation qui fonctionne vraiment.
 *
 * Le verrouillage par inactivité est décidé par le SERVEUR : une tablette dont
 * l'horloge a été reculée ne prolonge pas sa session.
 */
export const requireStationSession: RequestHandler = (req, _res, next) => {
  void (async () => {
    const token = readStationToken(req);
    if (!token) {
      next(new HttpError(401, "STATION_SESSION_REQUIRED", "Identifiez-vous sur la tablette."));
      return;
    }

    const found = await repoFindSessionByToken(token);
    if (!found) {
      next(new HttpError(401, "STATION_SESSION_UNKNOWN", "Session inconnue. Identifiez-vous à nouveau."));
      return;
    }

    const { session, device, user } = found;

    // L'appareil prime sur la session : une tablette révoquée ferme tout.
    if (device.status === "REVOKED" || device.status === "DISABLED") {
      await repoSetSessionState({
        sessionId: session.id,
        state: "REVOKED",
        reason: `DEVICE_${device.status}`,
      }).catch(() => undefined);
      await repoStationAudit({
        event_type: "AUTHORIZATION_DENIED",
        outcome: "DENIED",
        reason_code: `DEVICE_${device.status}`,
        device_id: device.id,
        session_id: session.id,
        user_id: user.id,
      });
      next(
        new HttpError(
          403,
          device.status === "REVOKED" ? "STATION_DEVICE_REVOKED" : "STATION_DEVICE_DISABLED",
          "Cette tablette n'est plus autorisée. Contactez le chef d'atelier."
        )
      );
      return;
    }

    const evaluation = evaluateSession({
      session,
      autoLockSeconds: device.auto_lock_seconds,
      now: new Date(),
    });

    if (!evaluation.usable) {
      // Le verrouillage n'arrête AUCUN pointage : c'est la règle centrale du
      // module. On persiste seulement l'état de l'écran.
      if (evaluation.reason === "IDLE_LOCK" && session.state === "ACTIVE") {
        await repoSetSessionState({ sessionId: session.id, state: "LOCKED" }).catch(() => undefined);
        await repoStationAudit({
          event_type: "SESSION_LOCKED",
          reason_code: "IDLE",
          device_id: device.id,
          session_id: session.id,
          user_id: user.id,
        });
      }
      if (evaluation.reason === "EXPIRED" && (session.state === "ACTIVE" || session.state === "LOCKED")) {
        await repoSetSessionState({
          sessionId: session.id,
          state: "EXPIRED",
          reason: "MAX_DURATION",
        }).catch(() => undefined);
        await repoStationAudit({
          event_type: "SESSION_EXPIRED",
          device_id: device.id,
          session_id: session.id,
          user_id: user.id,
        });
      }

      const codes: Record<string, { code: string; message: string }> = {
        EXPIRED: {
          code: "STATION_SESSION_EXPIRED",
          message: "Session expirée. Identifiez-vous à nouveau. Votre pointage en cours n'a pas été arrêté.",
        },
        IDLE_LOCK: {
          code: "STATION_SESSION_LOCKED",
          message: "Écran verrouillé par inactivité. Présentez votre badge. Votre pointage en cours n'a pas été arrêté.",
        },
        LOCKED: {
          code: "STATION_SESSION_LOCKED",
          message: "Écran verrouillé. Présentez votre badge pour reprendre.",
        },
        CLOSED: {
          code: "STATION_SESSION_CLOSED",
          message: "Session fermée. Identifiez-vous à nouveau.",
        },
      };
      const mapped = codes[evaluation.reason] ?? codes.CLOSED;
      next(new HttpError(401, mapped.code, mapped.message));
      return;
    }

    req.station = {
      session_id: session.id,
      device_id: device.id,
      device_code: device.public_code,
      device_zone: device.workshop_zone,
      device_assignment_mode: device.assignment_mode,
      machine_id: session.machine_id,
      user,
      auto_lock_seconds: device.auto_lock_seconds,
    };

    // Prolongation d'activité : elle est posée par le serveur (`now()`), pas
    // par l'horloge de la tablette.
    await repoTouchSession(session.id).catch(() => undefined);
    next();
  })().catch(next);
};

/**
 * Variante tolérante : la session est chargée si elle existe, sans exiger
 * qu'elle soit vivante. Utilisée par le bootstrap, qui doit pouvoir afficher
 * l'écran verrouillé sans être lui-même refusé.
 */
export const loadStationSessionIfAny: RequestHandler = (req, _res, next) => {
  void (async () => {
    const token = readStationToken(req);
    if (!token) {
      next();
      return;
    }
    const found = await repoFindSessionByToken(token);
    if (!found) {
      next();
      return;
    }
    const { session, device, user } = found;
    if (device.status !== "ACTIVE") {
      next();
      return;
    }
    const evaluation = evaluateSession({
      session,
      autoLockSeconds: device.auto_lock_seconds,
      now: new Date(),
    });
    if (!evaluation.usable) {
      next();
      return;
    }
    req.station = {
      session_id: session.id,
      device_id: device.id,
      device_code: device.public_code,
      device_zone: device.workshop_zone,
      device_assignment_mode: device.assignment_mode,
      machine_id: session.machine_id,
      user,
      auto_lock_seconds: device.auto_lock_seconds,
    };
    next();
  })().catch(next);
};

/**
 * Garde de capacité. Refus par défaut : être identifié sur une tablette
 * n'accorde AUCUN droit implicite. La garde est rejouée à chaque requête —
 * masquer un bouton côté UI n'a jamais été une autorisation.
 *
 * Elle accepte deux origines d'identité, jamais une troisième :
 *   * la session de poste (`req.station`), pour la tablette ;
 *   * le JWT ERP (`req.user`), pour l'administration depuis le poste bureau.
 */
export function requireStationCapability(capability: StationCapability): RequestHandler {
  return (req, _res, next) => {
    const role = req.station?.user.role ?? req.user?.role ?? null;
    const userId = req.station?.user.id ?? req.user?.id ?? null;

    if (!userId) {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    if (!roleHasStationCapability(role, capability)) {
      void repoStationAudit({
        event_type: "AUTHORIZATION_DENIED",
        outcome: "DENIED",
        reason_code: capability,
        device_id: req.station?.device_id ?? null,
        session_id: req.station?.session_id ?? null,
        user_id: userId,
        detail: { capability, path: req.path },
      });
      next(
        new HttpError(
          403,
          "STATION_CAPABILITY_REQUIRED",
          `La capacité de poste '${capability}' est requise.`
        )
      );
      return;
    }
    next();
  };
}

/**
 * Toute commande à effet exige une clé d'idempotence. Sans elle, un double-clic
 * sur un écran tactile — geste très fréquent avec des gants — produirait deux
 * effets.
 */
export const requireStationIdempotencyKey: RequestHandler = (req, _res, next) => {
  const raw = req.headers["idempotency-key"];
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key.length < 8 || key.length > 200) {
    next(
      new HttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "L'en-tête Idempotency-Key est requis (8 à 200 caractères) pour cette action."
      )
    );
    return;
  }
  next();
};
