import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../../../utils/httpError";

const mocks = vi.hoisted(() => ({
  listOperations: vi.fn(),
  activeEvent: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock("../repository/planning.repository", () => ({
  repoGetActivePlanningEventForOfOperation: mocks.activeEvent,
  repoListOfOperationsForAutoplan: mocks.listOperations,
  repoCreatePlanningEvent: mocks.createEvent,
}));

import { svcAutoPlanPlanning } from "./planning.service";

describe("planning auto-plan remediation contract", () => {
  beforeEach(() => {
    mocks.listOperations.mockReset();
    mocks.activeEvent.mockReset();
    mocks.createEvent.mockReset();
    mocks.listOperations.mockResolvedValue([{
      of_id: 7,
      of_numero: "OF-7",
      of_priority: "NORMAL",
      of_operation_id: "44444444-4444-4444-8444-444444444444",
      phase: 10,
      designation: "Usinage",
      planned_duration_minutes: 54,
      status: "TODO",
      machine_id: "11111111-1111-4111-8111-111111111111",
      poste_id: null,
    }]);
    mocks.activeEvent.mockResolvedValue(null);
  });

  it("preserves the actionable Methods route when a machine is not qualified", async () => {
    mocks.createEvent.mockRejectedValue(new HttpError(
      422,
      "PLANNING_MACHINE_QUALIFICATION_REQUIRED",
      "La machine sélectionnée n'a pas de famille qualifiée.",
      {
        remediation_path: "/methodes/parc-machines",
        action: "Renseignez la qualification de la machine dans le référentiel Méthodes.",
      },
    ));

    const result = await svcAutoPlanPlanning({
      body: { of_ids: [7], step_minutes: 15, skip_planned: true, include_done: false },
      audit: {
        user_id: 1,
        role: "Production",
        ip: "127.0.0.1",
        user_agent: "vitest",
        device_type: null,
        os: null,
        browser: null,
        path: "/api/v1/planning/autoplan",
        page_key: "planning",
        client_session_id: "planning-test",
      },
    });

    expect(result.created_events).toHaveLength(0);
    expect(result.skipped_operations).toEqual([expect.objectContaining({
      of_id: 7,
      reason: "RESOURCE_NOT_QUALIFIED",
      error_code: "PLANNING_MACHINE_QUALIFICATION_REQUIRED",
      remediation_path: "/methodes/parc-machines",
      action: "Renseignez la qualification de la machine dans le référentiel Méthodes.",
    })]);
  });
});
