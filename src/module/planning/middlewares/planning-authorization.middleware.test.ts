import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { requirePlanningCapability } from "./planning-authorization.middleware";
import { HttpError } from "../../../utils/httpError";

function request(role: string, elevated: boolean): Request {
  return {
    user: { id: 42, role },
    accountModuleAccess: {
      userId: 42,
      moduleKey: "production",
      granted: true,
      elevated,
    },
  } as Request;
}

describe("requirePlanningCapability", () => {
  it("does not turn default module access into a capacity privilege", () => {
    const next = vi.fn();
    requirePlanningCapability("read_capacity")(
      request("Employee | Opérateur atelier", false),
      {} as Response,
      next,
    );

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403, code: "PLANNING_CAPABILITY_REQUIRED" });
  });

  it("allows a planner through ordinary module access", () => {
    const next = vi.fn();
    requirePlanningCapability("manage_schedule")(
      request("Employee | Responsable Programmation", false),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it("honours an explicit account override as an elevated grant", () => {
    const next = vi.fn();
    requirePlanningCapability("read_capacity")(
      request("Employee", true),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });
});
