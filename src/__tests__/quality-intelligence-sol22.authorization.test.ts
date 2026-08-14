import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { HttpError } from "../utils/httpError";
import { requireQualityCapability } from "../module/qualite/middlewares/quality-authorization.middleware";

function qualityRequest(role: string, elevated: boolean): Request {
  return {
    user: { id: 42, role },
    accountModuleAccess: {
      userId: 42,
      moduleKey: "qualite",
      granted: true,
      elevated,
    },
  } as Request;
}

describe("SOL-22 quality capability boundary", () => {
  it("ne transforme pas l'accès ordinaire au module en privilège analytique", () => {
    const next = vi.fn();
    requireQualityCapability("analytics_read")(
      qualityRequest("Employee | Opérateur atelier", false),
      {} as Response,
      next,
    );

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403, code: "QUALITY_CAPABILITY_REQUIRED" });
  });

  it("autorise un rôle qualité avec un accès module ordinaire", () => {
    const next = vi.fn();
    requireQualityCapability("analytics_read")(
      qualityRequest("Responsable Qualité", false),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it("honore une dérogation de compte explicitement élevée", () => {
    const next = vi.fn();
    requireQualityCapability("analytics_read")(
      qualityRequest("Employee", true),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });
});
