import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: vi.fn() },
}));

import { repoDeleteCommande } from "./commande-client.repository";

const initialRow = {
  order_type: "FERME",
  raw_statut: "ATTENTE_TECHNIQUE",
  checkpoint_status: "active",
  responsible_role: "technique",
  assigned_user_id: null,
  initial_history_only: true,
  initial_event_only: true,
  has_business_artifacts: false,
};

function mockDeleteCandidate(overrides: Partial<typeof initialRow>) {
  const row = { ...initialRow, ...overrides };
  mocks.clientQuery.mockImplementation(async (sql: unknown) => {
    const query = String(sql);
    if (query.includes("SELECT order_type") && query.includes("FROM public.commande_client") && query.includes("FOR UPDATE")) {
      return { rows: [{ order_type: row.order_type }] };
    }
    if (query.includes("has_business_artifacts")) {
      const { order_type: _orderType, ...stateRow } = row;
      return { rows: [stateRow] };
    }
    if (query.includes("DELETE FROM public.commande_client")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
}

beforeEach(() => {
  mocks.connect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.release.mockReset();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
});

describe("commande hard-delete retention guard", () => {
  it.each([
    ["une commande interne", { order_type: "INTERNE" }],
    ["une commande en production", { raw_statut: "EN_PRODUCTION", initial_history_only: false, initial_event_only: false }],
    ["une commande archivée", { raw_statut: "ARCHIVE", initial_history_only: false, initial_event_only: false }],
    ["une commande portant un artefact métier", { has_business_artifacts: true }],
  ])("refuse %s et ne lance aucun DELETE", async (_label, overrides) => {
    mockDeleteCandidate(overrides);

    await expect(repoDeleteCommande("123", { user_id: 7, user_role: "Production" }))
      .rejects.toMatchObject({ status: 409, code: "COMMANDE_DELETE_REQUIRES_ARCHIVE" });

    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.commande_client"))).toBe(false);
  });

  it("verrouille la commande avant d'évaluer les artefacts de rétention", async () => {
    mockDeleteCandidate({ has_business_artifacts: true });

    await expect(repoDeleteCommande("123", { user_id: 7, user_role: "Production" }))
      .rejects.toMatchObject({ status: 409, code: "COMMANDE_DELETE_REQUIRES_ARCHIVE" });

    const commandLockIndex = mocks.clientQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("SELECT order_type") && String(sql).includes("FOR UPDATE")
    );
    const retentionIndex = mocks.clientQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("has_business_artifacts")
    );
    expect(commandLockIndex).toBeGreaterThanOrEqual(0);
    expect(retentionIndex).toBeGreaterThan(commandLockIndex);

    const guardSql = String(mocks.clientQuery.mock.calls[retentionIndex]?.[0] ?? "");
    expect(guardSql).toContain("FROM public.facture invoice");
    expect(guardSql).toContain("FROM public.commande_cadre_release cadre_release");
    expect(guardSql).toContain("FROM public.commande_fournisseur_ligne supplier_line");
    expect(guardSql).toContain("FROM public.commande_ligne_affaire_allocation allocation");
    expect(guardSql).toContain("FROM public.stock_reservations reservation");
    expect(guardSql).toContain("FROM public.article_devis_promotion article_promotion");
    expect(guardSql).toContain("FROM public.quick_commande_confirmations quick_confirmation");
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.commande_client"))).toBe(false);
  });

  it("refuse un rôle non propriétaire du checkpoint initial", async () => {
    mockDeleteCandidate({});

    await expect(repoDeleteCommande("123", { user_id: 7, user_role: "Commercial" }))
      .rejects.toMatchObject({ status: 403, code: "WORKFLOW_CHECKPOINT_FORBIDDEN" });

    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.commande_client"))).toBe(false);
  });

  it("autorise le responsable technique uniquement sur l'état initial sans artefact", async () => {
    mockDeleteCandidate({});

    await expect(repoDeleteCommande("123", { user_id: 7, user_role: "Production" })).resolves.toBe(true);

    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.commande_client"))).toBe(true);
  });
});
