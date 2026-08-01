import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  audit: vi.fn(),
  requireSnapshot: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: vi.fn() },
}));
vi.mock("./workflow.repository.shared", () => ({
  insertGlobalFinanceAudit: mocks.audit,
  issuerSnapshotAt: vi.fn(),
  requireFinanceIssuerSnapshotAt: mocks.requireSnapshot,
}));

import {
  repoActivateFinanceConfiguration,
  repoCreateFinanceSequences,
} from "./finance-configuration.repository";

const input = {
  confirm: true as const,
  legal_entity_code: "b7c1e5a2-3f4d-4e8b-9a06-380569012000",
  policy_version: "finance-2026-v1",
  effective_from: "2026-01-01",
  effective_to: null,
  eligible_delivery_statuses: ["SHIPPED", "DELIVERED"] as ("SHIPPED" | "DELIVERED")[],
  require_distinct_issuer: true,
  sequences: { facture: { year: 2026, prefix: "FAC-2026-", next_value: 1, padding: 6 } },
};
const actor = { userId: 7, requestId: "request-id", path: "/api/v1/factures/configuration/activate" };
const sequenceInput = {
  confirm: true as const,
  sequences: { avoir: { year: 2027, prefix: "AVO-2027-", next_value: 1, padding: 6 } },
};

beforeEach(() => {
  mocks.query.mockReset(); mocks.release.mockReset(); mocks.connect.mockReset(); mocks.audit.mockReset(); mocks.requireSnapshot.mockReset();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.requireSnapshot.mockResolvedValue({ company_name: "Issuer" });
});

describe("repoActivateFinanceConfiguration", () => {
  it("creates the policy and sequence atomically and records a global audit", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ biller_id: input.legal_entity_code }] })
      .mockResolvedValueOnce({ rows: [] }) // version
      .mockResolvedValueOnce({ rows: [] }) // overlap
      .mockResolvedValueOnce({ rows: [] }) // sequence scope
      .mockResolvedValueOnce({ rows: [{ id: "policy-id" }] })
      .mockResolvedValueOnce({ rows: [] }) // sequence insert
      .mockResolvedValueOnce({ rows: [] }); // commit

    await expect(repoActivateFinanceConfiguration({ input, actor })).resolves.toMatchObject({ id: "policy-id", active: true });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ entityId: "policy-id", actor }));
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rolls back and never audits when an active policy overlaps", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ biller_id: input.legal_entity_code }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "other-policy" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repoActivateFinanceConfiguration({ input, actor })).rejects.toMatchObject({ code: "FINANCE_BILLING_POLICY_OVERLAP" });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("rolls back if the legal sequence scope already exists", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ biller_id: input.legal_entity_code }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "existing-sequence" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repoActivateFinanceConfiguration({ input, actor })).rejects.toMatchObject({ code: "FINANCE_LEGAL_SEQUENCE_SCOPE_EXISTS" });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});

describe("repoCreateFinanceSequences", () => {
  it("creates missing scopes atomically and records a global audit", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ legal_entity_code: input.legal_entity_code, policy_version: input.policy_version }] })
      .mockResolvedValueOnce({ rows: [] }) // scope
      .mockResolvedValueOnce({ rows: [] }) // insert
      .mockResolvedValueOnce({ rows: [] }); // commit

    await expect(repoCreateFinanceSequences({ input: sequenceInput, actor })).resolves.toMatchObject({
      legal_entity_code: input.legal_entity_code,
      sequences: [{ document_type: "AVOIR", year: 2027, active: true }],
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "facturation.configuration.sequences_created",
      entityId: input.legal_entity_code,
    }));
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("rolls back without auditing when a requested scope already exists", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ legal_entity_code: input.legal_entity_code, policy_version: input.policy_version }] })
      .mockResolvedValueOnce({ rows: [{ id: "existing-sequence" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repoCreateFinanceSequences({ input: sequenceInput, actor })).rejects.toMatchObject({
      code: "FINANCE_LEGAL_SEQUENCE_SCOPE_EXISTS",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
