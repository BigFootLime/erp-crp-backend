import { describe, expect, it } from "vitest";

import { updateMachineMaintenancePlanSchema } from "./machine-park.validators";

const revision = "2026-10-25T12:00:00.000Z";

describe("parc machines — PATCH sans défauts de création", () => {
  it("ne réactive ni ne vide un plan lorsqu'un autre champ est modifié", () => {
    expect(updateMachineMaintenancePlanSchema.parse({ body: { notes: "Contrôle reporté", expected_updated_at: revision } }).body).toEqual({
      notes: "Contrôle reporté",
      expected_updated_at: revision,
    });
  });

  it("accepte une modification explicite du statut, de la checklist et de la source", () => {
    const parsed = updateMachineMaintenancePlanSchema.parse({
      body: {
        status: "PAUSED",
        checklist: [{ id: "lubrification", label: "Vérifier la lubrification", blocks_machine: false }],
        source: "maintenance_planifiee",
        expected_updated_at: revision,
      },
    }).body;

    expect(parsed).toMatchObject({
      status: "PAUSED",
      checklist: [{ id: "lubrification", label: "Vérifier la lubrification", blocks_machine: false }],
      source: "maintenance_planifiee",
    });
  });
});
