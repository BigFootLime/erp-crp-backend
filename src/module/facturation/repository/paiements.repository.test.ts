// #126 — Garde-fou : un reglement enregistre mais pas encore affecte
// (`facture_id IS NULL`, `status='UNALLOCATED'`) doit rester VISIBLE dans la liste et
// compte dans le total. Un INNER JOIN sur `facture` le faisait disparaitre en silence.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { repoGetPaiement, repoListPaiements } from "./paiements.repository";

const query = vi.hoisted(() => vi.fn());

vi.mock("../../../config/database", () => ({
  default: { query },
}));

type Sql = { text: string; values: unknown[] };

function capturedSql(): Sql[] {
  return query.mock.calls.map(([text, values]) => ({ text: String(text), values: values ?? [] }));
}

const baseFilters = {
  page: 1,
  pageSize: 20,
  sortBy: "date_paiement" as const,
  sortDir: "desc" as const,
  include: "client,facture",
};

describe("repoListPaiements — visibilite des reglements non affectes", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("joint la facture en LEFT JOIN dans le comptage ET dans les donnees", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await repoListPaiements({ ...baseFilters });

    const [countSql, dataSql] = capturedSql();
    expect(countSql.text).toContain("LEFT JOIN facture");
    expect(countSql.text).not.toMatch(/(?<!LEFT )JOIN facture/);
    expect(dataSql.text).toContain("LEFT JOIN facture");
    expect(dataSql.text).not.toMatch(/(?<!LEFT )JOIN facture/);
  });

  it("expose status et workflow_status dans le contrat de liste", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await repoListPaiements({ ...baseFilters });

    const [, dataSql] = capturedSql();
    expect(dataSql.text).toContain("p.status");
    expect(dataSql.text).toContain("p.workflow_status");
  });

  it("renvoie facture_id null et facture null sans lever, pour un reglement non affecte", async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 1 }] }).mockResolvedValueOnce({
      rows: [
        {
          id: "42",
          facture_id: null,
          client_id: "CLI-1",
          date_paiement: "2026-07-20",
          montant: 1500.5,
          mode: "Virement",
          reference: "VIR-9001",
          status: "UNALLOCATED",
          workflow_status: "RECORDED",
          updated_at: "2026-07-20T10:00:00.000Z",
          client: null,
          facture: null,
        },
      ],
    });

    const result = await repoListPaiements({ ...baseFilters });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(42);
    expect(result.items[0].facture_id).toBeNull();
    expect(result.items[0].facture).toBeNull();
    expect(result.items[0].status).toBe("UNALLOCATED");
    expect(result.items[0].workflow_status).toBe("RECORDED");
  });

  it("convertit toujours facture_id en entier quand le reglement est affecte", async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 1 }] }).mockResolvedValueOnce({
      rows: [
        {
          id: "7",
          facture_id: "1234",
          client_id: "CLI-1",
          date_paiement: "2026-07-20",
          montant: 100,
          mode: null,
          reference: null,
          status: "ALLOCATED",
          workflow_status: "ALLOCATED",
          updated_at: "2026-07-20T10:00:00.000Z",
          client: null,
          facture: { id: 1234, numero: "FA-2026-0001", client_id: "CLI-1" },
        },
      ],
    });

    const result = await repoListPaiements({ ...baseFilters });

    expect(result.items[0].facture_id).toBe(1234);
    expect(result.items[0].facture).toEqual({ id: 1234, numero: "FA-2026-0001", client_id: "CLI-1" });
  });

  it("filtre sur status cote serveur", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await repoListPaiements({ ...baseFilters, status: "UNALLOCATED" });

    const [countSql] = capturedSql();
    expect(countSql.text).toContain("p.status =");
    expect(countSql.values).toContain("UNALLOCATED");
  });

  it("expose un raccourci `unallocated` qui filtre sur l'absence de facture", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await repoListPaiements({ ...baseFilters, unallocated: true });

    const [countSql] = capturedSql();
    expect(countSql.text).toContain("p.facture_id IS NULL");
  });
});

describe("repoGetPaiement — lecture d'un reglement non affecte", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("ne renvoie plus 404 faute de facture rattachee", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: "42",
          facture_id: null,
          client_id: "CLI-1",
          date_paiement: "2026-07-20",
          montant: 1500.5,
          mode: "Virement",
          reference: "VIR-9001",
          commentaire: null,
          status: "UNALLOCATED",
          workflow_status: "RECORDED",
          created_at: "2026-07-20T10:00:00.000Z",
          updated_at: "2026-07-20T10:00:00.000Z",
          client: null,
          facture: null,
        },
      ],
    });

    const paiement = await repoGetPaiement(42, "client,facture");

    expect(paiement).not.toBeNull();
    expect(paiement?.facture_id).toBeNull();
    expect(paiement?.status).toBe("UNALLOCATED");
    expect(capturedSql()[0].text).toContain("LEFT JOIN facture");
  });
});
