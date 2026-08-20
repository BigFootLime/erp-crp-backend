import { describe, expect, it, vi } from "vitest";
import {
  assertCommandePlanningResourcesCompatible,
  assertOperationResourceCompatible,
} from "./planning.repository";

const operationId = "44444444-4444-4444-8444-444444444444";
const machineId = "11111111-1111-4111-8111-111111111111";
const pieceId = "22222222-2222-4222-8222-222222222222";

function queryer(row: Record<string, unknown>) {
  return { query: vi.fn().mockResolvedValue({ rows: [row] }) };
}

async function expectCode(row: Record<string, unknown>, code: string) {
  const tx = queryer(row);
  await expect(assertOperationResourceCompatible({
    tx,
    of_operation_id: operationId,
    resource: { machine_id: machineId, poste_id: null },
  })).rejects.toMatchObject({ status: 422, code });
}

describe("planning machine qualification invariant", () => {
  it("blocks an operation whose required family is not qualified", async () => {
    await expectCode({
      operation_id: operationId,
      piece_technique_id: pieceId,
      required_machine_family_code: null,
      machine_id: machineId,
      machine_code: "M-01",
      machine_family_code: "TOURNAGE",
    }, "PLANNING_OPERATION_FAMILY_REQUIRED");
  });

  it("blocks a machine without a declared family", async () => {
    await expectCode({
      operation_id: operationId,
      piece_technique_id: pieceId,
      required_machine_family_code: "TOURNAGE",
      machine_id: machineId,
      machine_code: "M-01",
      machine_family_code: null,
    }, "PLANNING_MACHINE_QUALIFICATION_REQUIRED");
  });

  it("blocks an incompatible family", async () => {
    await expectCode({
      operation_id: operationId,
      piece_technique_id: pieceId,
      required_machine_family_code: "TOURNAGE",
      machine_id: machineId,
      machine_code: "M-01",
      machine_family_code: "FRAISAGE",
    }, "PLANNING_MACHINE_FAMILY_INCOMPATIBLE");
  });

  it("accepts an explicitly matching family", async () => {
    const tx = queryer({
      operation_id: operationId,
      piece_technique_id: pieceId,
      required_machine_family_code: "tournage",
      machine_id: machineId,
      machine_code: "M-01",
      machine_family_code: "TOURNAGE",
    });
    await expect(assertOperationResourceCompatible({
      tx,
      of_operation_id: operationId,
      resource: { machine_id: machineId, poste_id: null },
    })).resolves.toBeUndefined();
  });

  it("reuses the same qualification invariant before validating a customer order", async () => {
    const tx = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{ of_operation_id: operationId, machine_id: machineId, poste_id: null }],
        })
        .mockResolvedValueOnce({
          rows: [{
            operation_id: operationId,
            piece_technique_id: pieceId,
            required_machine_family_code: "TOURNAGE",
            machine_id: machineId,
            machine_code: "M-01",
            machine_family_code: null,
          }],
        }),
    };

    await expect(assertCommandePlanningResourcesCompatible({ tx, commande_id: 42 }))
      .rejects.toMatchObject({ status: 422, code: "PLANNING_MACHINE_QUALIFICATION_REQUIRED" });
  });
});
