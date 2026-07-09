import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError";
import { ApiError } from "../utils/apiError";

// Message générique renvoyé au client pour toute erreur serveur (5xx) ou inconnue.
// CA-SEC-04 : ne jamais fuiter d'internes (message d'exception brut, nom de colonne/table,
// stack) au client. Le message réel + la stack restent dans les logs serveur. Le client
// peut corréler via l'en-tête X-Request-Id (posé par requestIdMiddleware sur chaque réponse).
// Volontairement indépendant de NODE_ENV : en prod le backend tourne avec NODE_ENV=development
// (cf. /environment.appEnv), donc un gate sur NODE_ENV ne se déclencherait pas. On masque
// dans tous les environnements — le dev garde le détail complet dans les logs serveur.
const GENERIC_SERVER_ERROR_MESSAGE = "Erreur serveur.";

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const isKnown = err instanceof HttpError || err instanceof ApiError;
  const status = isKnown ? err.status : 500;
  const code = isKnown ? err.code : "INTERNAL_ERROR";

  // Les erreurs "connues" (HttpError/ApiError) < 500 portent un message volontaire et sûr
  // pour le client (ex. "Pièce introuvable", messages de validation). Toute 5xx ou erreur
  // inconnue reçoit le message générique — jamais le message d'exception brut.
  const message =
    isKnown && status < 500 ? (err.message ?? GENERIC_SERVER_ERROR_MESSAGE) : GENERIC_SERVER_ERROR_MESSAGE;

  const payload = {
    success: false,
    message,
    code,
    path: req.originalUrl,
  };

  // logs détaillés côté serveur (JAMAIS renvoyés au client) — inclut le message réel + la stack.
  console.error("[ERROR]", {
    status,
    code,
    message: err?.message ?? null,
    clientMessage: message,
    method: req.method,
    path: req.originalUrl,
    requestId: req.requestId ?? null,
    details: err?.details,
    stack: err?.stack,
  });

  res.status(status).json(payload);
}
