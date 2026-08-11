import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

import { errorHandler } from "../middlewares/errorHandler";
import { HttpError } from "../utils/httpError";
import { ApiError } from "../utils/apiError";
import { setLogSinkForTests } from "../shared/observability/logger";

// CA-SEC-04 — le gestionnaire d'erreurs ne doit JAMAIS renvoyer d'internes (message
// d'exception brut, nom de colonne/table, adresse, stack) au client sur une 5xx / erreur
// inconnue. Les erreurs "connues" (HttpError/ApiError) < 500 conservent leur message
// volontaire. Le message réel reste dans les logs serveur (console.error).

function mockReqRes(originalUrl = "/api/v1/production/ofs") {
  const req = { originalUrl, method: "GET", requestId: "req-test-123" } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  return { req, res, status, json };
}

describe("CA-SEC-04 — errorHandler ne fuite pas d'internes sur 5xx", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logLines: string[];
  beforeEach(() => {
    logLines = [];
    setLogSinkForTests((line) => logLines.push(line));
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    setLogSinkForTests(null);
    errSpy.mockRestore();
  });

  it("erreur inconnue (erreur SQL) → 500 + message générique + code INTERNAL_ERROR, pas de fuite", () => {
    const { req, res, status, json } = mockReqRes();
    const leak = "column o.parent_of_id does not exist";

    errorHandler(new Error(leak), req, res, () => {});

    expect(status).toHaveBeenCalledWith(500);
    const payload = json.mock.calls[0][0];
    expect(payload).toEqual({
      success: false,
      message: "Erreur serveur.",
      code: "INTERNAL_ERROR",
      path: "/api/v1/production/ofs",
    });
    // le message brut de la colonne ne doit PAS atteindre le client
    expect(JSON.stringify(payload)).not.toContain("parent_of_id");
  });

  it("le message réel est bien journalisé côté serveur (pour le diagnostic)", () => {
    const { req, res } = mockReqRes();
    const leak = 'column "due_date" does not exist';

    errorHandler(new Error(leak), req, res, () => {});

    // présent dans les logs serveur (console.error), absent de la réponse client
    expect(logLines.join("\n")).toContain('"error_fingerprint"');
    expect(logLines.join("\n")).not.toContain("due_date");
  });

  it("journalise seulement le nom sûr de la contrainte SQL", () => {
    const { req, res } = mockReqRes();

    errorHandler({
      name: "error",
      code: "23503",
      constraint: "commande_ligne_article_id_fkey",
      detail: "Key (article_id)=(sensitive) is not present",
    }, req, res, () => {});

    const log = logLines.join("\n");
    expect(log).toContain('"failure_constraint":"commande_ligne_article_id_fkey"');
    expect(log).not.toContain("sensitive");
  });

  it("HttpError < 500 conserve son message volontaire (ex. 404)", () => {
    const { req, res, status, json } = mockReqRes();

    errorHandler(new HttpError(404, "PIECE_NOT_FOUND", "Pièce introuvable"), req, res, () => {});

    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0]).toEqual({
      success: false,
      message: "Pièce introuvable",
      code: "PIECE_NOT_FOUND",
      path: "/api/v1/production/ofs",
    });
  });

  it("ApiError 409 conserve son message métier", () => {
    const { req, res, status, json } = mockReqRes();

    errorHandler(new ApiError(409, "ALREADY_LINKED", "Article déjà lié à une pièce"), req, res, () => {});

    expect(status).toHaveBeenCalledWith(409);
    const payload = json.mock.calls[0][0];
    expect(payload.message).toBe("Article déjà lié à une pièce");
    expect(payload.code).toBe("ALREADY_LINKED");
  });

  it("traduit le SQLSTATE SOL-06 en refus métier actionnable sans exposer le SQL", () => {
    const { req, res, status, json } = mockReqRes("/api/v1/stock/movements");
    const prerequisite = {
      prerequisite_code: "STOCK_VALUATION_POLICY",
      ready: false,
      definition: "Méthode de valorisation sourcée.",
      unit: "METHOD",
      period_start: null,
      period_end: null,
      source: "public.erp_settings",
      freshness_at: null,
      reliability: "MISSING",
      actual_value: {},
      expected_value: "WEIGHTED_AVERAGE, FIFO ou SPECIFIC_IDENTIFICATION",
      remediation: "Renseignez stock.valuation_method.",
    };

    errorHandler({
      code: "P2606",
      detail: JSON.stringify([prerequisite]),
      message: "internal trigger at C:\\private\\database.sql:42",
    }, req, res, () => {});

    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0]).toEqual({
      success: false,
      message: "Le flux ne peut pas démarrer : des référentiels obligatoires sont incomplets.",
      code: "BUSINESS_PREREQUISITES_MISSING",
      path: "/api/v1/stock/movements",
      details: {
        prerequisites: [prerequisite],
        suggested_action: "Corrigez les prérequis listés puis relancez la même commande idempotente.",
      },
    });
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("private");
  });

  it("HttpError >= 500 est aussi masquée (message générique, mais code conservé)", () => {
    const { req, res, status, json } = mockReqRes();

    errorHandler(new HttpError(503, "DB_DOWN", "connection refused at 10.0.0.5:5432"), req, res, () => {});

    expect(status).toHaveBeenCalledWith(503);
    const payload = json.mock.calls[0][0];
    expect(payload.message).toBe("Erreur serveur.");
    expect(payload.code).toBe("DB_DOWN");
    expect(JSON.stringify(payload)).not.toContain("10.0.0.5");
  });

  it.each([
    ["UPLOAD_SCAN_UNAVAILABLE", "Le contrôle antivirus est temporairement indisponible. Réessayez plus tard."],
    ["UPLOAD_STAGING_PERMISSION_FAILED", "La zone sécurisée de dépôt est temporairement indisponible. Réessayez plus tard ou contactez l’administrateur."],
    ["UPLOAD_CLEANUP_FAILED", "Le nettoyage sécurisé du fichier n’a pas pu être confirmé. Ne relancez pas l’envoi et contactez l’administrateur."],
    ["UPLOAD_COMMIT_UNCERTAIN", "Le résultat de l’enregistrement doit être vérifié. Ne relancez pas l’opération avant actualisation."],
    ["UPLOAD_ROLLBACK_UNCERTAIN", "L’annulation n’a pas pu être confirmée. Le fichier est préservé ; une vérification est requise avant toute nouvelle tentative."],
    ["GED_COMMIT_UNCERTAIN", "Le résultat du dépôt GED doit être vérifié. Ne relancez pas le dépôt avant actualisation."],
    ["GED_UPLOAD_COMMIT_UNCERTAIN", "Le résultat du dépôt GED doit être vérifié. Ne relancez pas le dépôt avant actualisation."],
    ["GED_ROLLBACK_UNCERTAIN", "L’annulation du dépôt GED n’a pas pu être confirmée. Le fichier est préservé ; contactez l’administrateur."],
    ["GED_BLOB_CLEANUP_UNCERTAIN", "Le rapprochement du fichier GED n’a pas pu être confirmé. Ne relancez pas le dépôt et contactez l’administrateur."],
    ["GED_VAULT_STAGING_CLEANUP_FAILED", "Le nettoyage du staging GED n’a pas pu être confirmé. Ne relancez pas le dépôt et contactez l’administrateur."],
    ["METROLOGY_COMMIT_UNCERTAIN", "Le résultat du dépôt métrologique doit être vérifié. Ne relancez pas l’opération avant actualisation."],
    ["METROLOGY_ROLLBACK_UNCERTAIN", "L’annulation du dépôt métrologique n’a pas pu être confirmée. La preuve est préservée ; contactez l’administrateur."],
    ["PO_COMMIT_UNCERTAIN", "Le résultat du dépôt Project Office doit être vérifié. Ne relancez pas l’opération avant actualisation."],
    ["PO_UPLOAD_COMMIT_UNCERTAIN", "Le résultat du dépôt Project Office doit être vérifié. Ne relancez pas l’opération avant actualisation."],
    ["PO_UPLOAD_COMMIT_NOT_APPLIED", "Le dépôt Project Office n’a pas été appliqué. Vous pouvez réessayer."],
    ["PO_ROLLBACK_UNCERTAIN", "L’annulation du dépôt Project Office n’a pas pu être confirmée. Le fichier est préservé ; contactez l’administrateur."],
    ["LIVRAISON_PDF_COMMIT_UNCERTAIN", "Le résultat de l’enregistrement du PDF de livraison doit être vérifié. Ne relancez pas la génération avant actualisation."],
    ["OF_COMMIT_UNCERTAIN", "Le résultat de l’opération OF doit être vérifié. Ne relancez pas l’opération avant actualisation."],
    ["OF_DOCUMENT_COMMIT_UNCERTAIN", "Le résultat de l’émission du document OF doit être vérifié. Ne relancez pas l’émission avant actualisation."],
    ["OF_ROLLBACK_UNCERTAIN", "L’annulation de l’opération OF n’a pas pu être confirmée. Les fichiers sont préservés ; contactez l’administrateur."],
    ["OF_DOCUMENT_COMMIT_NOT_APPLIED", "L’émission du document OF n’a pas été appliquée. Vous pouvez réessayer."],
  ])("publie un conseil constant et sans fuite pour la 503 opérationnelle %s", (code, expectedMessage) => {
    const { req, res, json } = mockReqRes("/api/v1/ged?title=secret-client");
    const privateMessage = "EACCES C:\\private\\tenant-42\\document.pdf";
    const error = new HttpError(503, code, privateMessage, { absolutePath: "C:\\private\\tenant-42" });

    errorHandler(error, req, res, () => {});

    const payload = json.mock.calls[0][0];
    expect(payload).toEqual({
      success: false,
      message: expectedMessage,
      code,
      path: "/api/v1/ged",
    });
    expect(JSON.stringify(payload)).not.toContain("tenant-42");
    expect(JSON.stringify(payload)).not.toContain("absolutePath");
  });

  it.each([
    "GED_COMMIT_UNCERTAIN_DEBUG",
    "constructor",
    "toString",
    "__proto__",
  ])("garde une 5xx au message générique pour le code non autorisé %s", (code) => {
    const { req, res, json } = mockReqRes();

    errorHandler(
      new HttpError(503, code, "internal transaction detail"),
      req,
      res,
      () => {}
    );

    expect(json.mock.calls[0][0].message).toBe("Erreur serveur.");
  });
});
