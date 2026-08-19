import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError";
import { ApiError } from "../utils/apiError";
import { stripQueryFromUrl } from "../utils/logPath";
import { errorFingerprint, logger, safeErrorCode, safeErrorConstraint } from "../shared/observability/logger";
import { observabilityRoute } from "./requestLogger";

// Message générique renvoyé au client pour toute erreur serveur (5xx) ou inconnue.
// CA-SEC-04 : ne jamais fuiter d'internes (message d'exception brut, nom de colonne/table,
// stack) au client. Le message réel + la stack restent dans les logs serveur. Le client
// peut corréler via l'en-tête X-Request-Id (posé par requestIdMiddleware sur chaque réponse).
// Volontairement indépendant de NODE_ENV : en prod le backend tourne avec NODE_ENV=development
// (cf. /environment.appEnv), donc un gate sur NODE_ENV ne se déclencherait pas. On masque
// dans tous les environnements — le dev garde le détail complet dans les logs serveur.
const GENERIC_SERVER_ERROR_MESSAGE = "Erreur serveur.";

const REFERENCE_DATA_SQLSTATE = "P2606";
const REFERENCE_DATA_FIELDS = [
  "prerequisite_code", "ready", "definition", "unit", "period_start", "period_end",
  "source", "freshness_at", "reliability", "actual_value", "expected_value", "remediation",
] as const;

function mapReferenceDataError(error: unknown): HttpError | null {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== REFERENCE_DATA_SQLSTATE) {
    return null;
  }
  const rawDetail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDetail);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) return null;
  const prerequisites = parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const safe: Record<string, unknown> = {};
    for (const field of REFERENCE_DATA_FIELDS) {
      if (field in entry) safe[field] = (entry as Record<string, unknown>)[field];
    }
    return typeof safe.prerequisite_code === "string" && typeof safe.remediation === "string"
      ? safe
      : null;
  });
  if (prerequisites.some((entry) => entry === null)) return null;
  return new HttpError(
    409,
    "BUSINESS_PREREQUISITES_MISSING",
    "Le flux ne peut pas démarrer : des référentiels obligatoires sont incomplets.",
    {
      prerequisites,
      suggested_action: "Corrigez les prérequis listés puis relancez la même commande idempotente.",
    }
  );
}

// Closed allowlist for operational upload/commit failures where a generic 5xx
// would hide safety-critical retry guidance. Values are public constants: the
// exception's own message, details, path, and stack are never reused here.
const PUBLIC_OPERATIONAL_5XX_MESSAGES = new Map<string, string>([
  ["UPLOAD_SCAN_UNAVAILABLE",
    "Le contrôle antivirus est temporairement indisponible. Réessayez plus tard.",
  ],
  ["GED_SCAN_FAILED",
    "Le verdict antivirus n'a pas pu être obtenu. Le fichier reste isolé en quarantaine ; contactez l'administrateur.",
  ],
  ["UPLOAD_STAGING_PERMISSION_FAILED",
    "La zone sécurisée de dépôt est temporairement indisponible. Réessayez plus tard ou contactez l’administrateur.",
  ],
  ["UPLOAD_CLEANUP_FAILED",
    "Le nettoyage sécurisé du fichier n’a pas pu être confirmé. Ne relancez pas l’envoi et contactez l’administrateur.",
  ],
  ["UPLOAD_COMMIT_UNCERTAIN",
    "Le résultat de l’enregistrement doit être vérifié. Ne relancez pas l’opération avant actualisation.",
  ],
  ["UPLOAD_ROLLBACK_UNCERTAIN",
    "L’annulation n’a pas pu être confirmée. Le fichier est préservé ; une vérification est requise avant toute nouvelle tentative.",
  ],
  ["GED_COMMIT_UNCERTAIN",
    "Le résultat du dépôt GED doit être vérifié. Ne relancez pas le dépôt avant actualisation.",
  ],
  ["GED_UPLOAD_COMMIT_UNCERTAIN",
    "Le résultat du dépôt GED doit être vérifié. Ne relancez pas le dépôt avant actualisation.",
  ],
  ["GED_ROLLBACK_UNCERTAIN",
    "L’annulation du dépôt GED n’a pas pu être confirmée. Le fichier est préservé ; contactez l’administrateur.",
  ],
  ["GED_BLOB_CLEANUP_UNCERTAIN",
    "Le rapprochement du fichier GED n’a pas pu être confirmé. Ne relancez pas le dépôt et contactez l’administrateur.",
  ],
  ["GED_VAULT_STAGING_CLEANUP_FAILED",
    "Le nettoyage du staging GED n’a pas pu être confirmé. Ne relancez pas le dépôt et contactez l’administrateur.",
  ],
  ["METROLOGY_COMMIT_UNCERTAIN",
    "Le résultat du dépôt métrologique doit être vérifié. Ne relancez pas l’opération avant actualisation.",
  ],
  ["METROLOGY_ROLLBACK_UNCERTAIN",
    "L’annulation du dépôt métrologique n’a pas pu être confirmée. La preuve est préservée ; contactez l’administrateur.",
  ],
  ["PO_COMMIT_UNCERTAIN",
    "Le résultat du dépôt Project Office doit être vérifié. Ne relancez pas l’opération avant actualisation.",
  ],
  ["PO_UPLOAD_COMMIT_UNCERTAIN",
    "Le résultat du dépôt Project Office doit être vérifié. Ne relancez pas l’opération avant actualisation.",
  ],
  ["PO_UPLOAD_COMMIT_NOT_APPLIED",
    "Le dépôt Project Office n’a pas été appliqué. Vous pouvez réessayer.",
  ],
  ["PO_ROLLBACK_UNCERTAIN",
    "L’annulation du dépôt Project Office n’a pas pu être confirmée. Le fichier est préservé ; contactez l’administrateur.",
  ],
  ["LIVRAISON_PDF_COMMIT_UNCERTAIN",
    "Le résultat de l’enregistrement du PDF de livraison doit être vérifié. Ne relancez pas la génération avant actualisation.",
  ],
  ["OF_COMMIT_UNCERTAIN",
    "Le résultat de l’opération OF doit être vérifié. Ne relancez pas l’opération avant actualisation.",
  ],
  ["OF_DOCUMENT_COMMIT_UNCERTAIN",
    "Le résultat de l’émission du document OF doit être vérifié. Ne relancez pas l’émission avant actualisation.",
  ],
  ["OF_ROLLBACK_UNCERTAIN",
    "L’annulation de l’opération OF n’a pas pu être confirmée. Les fichiers sont préservés ; contactez l’administrateur.",
  ],
  ["OF_DOCUMENT_COMMIT_NOT_APPLIED",
    "L’émission du document OF n’a pas été appliquée. Vous pouvez réessayer.",
  ],
  ["DEVIS_SCHEMA_NOT_READY",
    "La création de devis est temporairement indisponible : le schéma commercial doit être mis à niveau. Contactez l’administrateur avant de réessayer.",
  ],
  ["DEVIS_IDEMPOTENCY_NOT_READY",
    "La création de devis est temporairement indisponible : le registre d’idempotence doit être mis à niveau. Contactez l’administrateur avant de réessayer.",
  ],
]);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const mappedReferenceDataError = mapReferenceDataError(err);
  const handledError = mappedReferenceDataError ?? err;
  const isKnown = handledError instanceof HttpError || handledError instanceof ApiError;
  const status = isKnown ? handledError.status : 500;
  const code = isKnown ? handledError.code : "INTERNAL_ERROR";

  // Les erreurs connues < 500 portent un message volontaire. Une 5xx ne devient
  // actionnable que si son code figure exactement dans l'allowlist ci-dessus.
  // Même alors, le texte vient de la constante publique, jamais de l'exception.
  const operationalMessage = isKnown && status >= 500
    ? PUBLIC_OPERATIONAL_5XX_MESSAGES.get(code)
    : undefined;
  const message = isKnown && status < 500
    ? (handledError.message ?? GENERIC_SERVER_ERROR_MESSAGE)
    : (operationalMessage ?? GENERIC_SERVER_ERROR_MESSAGE);

  // Path sans query string : les recherches métier mettent des PII en query
  // (?q=email, ?siret=...) ; ni la réponse ni les logs ne doivent les rejouer.
  const safePath = stripQueryFromUrl(req.originalUrl);

  // details : uniquement pour les erreurs 4xx construites volontairement (HttpError/ApiError
  // avec details explicites, ex. 409 doublon SIRET -> { client_id, company_name }). Jamais pour
  // les 5xx/erreurs inconnues (CA-SEC-04 : aucune fuite d'internes).
  const payload = {
    success: false,
    message,
    code,
    path: safePath,
    ...(handledError instanceof HttpError && status < 500 && typeof handledError.details !== "undefined"
      ? { details: handledError.details }
      : {}),
  };

  // logs détaillés côté serveur (JAMAIS renvoyés au client) — inclut le message réel + la stack.
  logger.error("http_request_failed", {
    http_status: status,
    error_code: code,
    failure_code: safeErrorCode(err),
    failure_constraint: safeErrorConstraint(err),
    failure_type: err instanceof Error ? err.name : "UnknownError",
    error_fingerprint: errorFingerprint(err),
    http_method: req.method,
    http_route: observabilityRoute(req),
  });

  res.status(status).json(payload);
}
