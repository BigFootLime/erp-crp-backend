import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

import { errorHandler } from "../middlewares/errorHandler";
import { HttpError } from "../utils/httpError";
import { ApiError } from "../utils/apiError";

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
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
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
    expect(JSON.stringify(errSpy.mock.calls.flat())).toContain("due_date");
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

  it("HttpError >= 500 est aussi masquée (message générique, mais code conservé)", () => {
    const { req, res, status, json } = mockReqRes();

    errorHandler(new HttpError(503, "DB_DOWN", "connection refused at 10.0.0.5:5432"), req, res, () => {});

    expect(status).toHaveBeenCalledWith(503);
    const payload = json.mock.calls[0][0];
    expect(payload.message).toBe("Erreur serveur.");
    expect(payload.code).toBe("DB_DOWN");
    expect(JSON.stringify(payload)).not.toContain("10.0.0.5");
  });
});
