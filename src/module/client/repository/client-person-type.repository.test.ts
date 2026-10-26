import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect } }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock("../../../shared/codes/code-generator.service", () => ({ generateClientCode: vi.fn().mockResolvedValue("CLI-001") }));

import { repoCreateClient, repoPatchClient } from "./client.repository";
import { clientPatchSchema, createClientSchema } from "../validators/client.validators";

const audit = {
  user_id: 1, ip: null, user_agent: null, device_type: null, os: null, browser: null,
  path: "/api/v1/clients/test", page_key: null, client_session_id: null,
};
const clientId = "00000000-0000-4000-8000-000000000001";

function currentClient(overrides: Record<string, unknown> = {}) {
  return {
    client_id: clientId, bill_address_id: null, delivery_address_id: null, bank_info_id: null,
    primary_contact_id: null, customer_type: "PROFESSIONAL", individual_first_name: null,
    individual_last_name: null, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM clients WHERE client_id = $1 FOR UPDATE")) return { rows: [currentClient()] };
    return { rows: [] };
  });
  mocks.audit.mockResolvedValue(undefined);
});

describe("repoPatchClient — identité particulier (#1454)", () => {
  it("insère les six premières colonnes dans l'ordre et préserve les NULL des noms professionnels", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE siret = $1")) return { rows: [] };
      if (sql.includes("INSERT INTO adresse_facturation")) return { rows: [{ bill_address_id: "bill-1" }] };
      if (sql.includes("INSERT INTO adresse_livraison")) return { rows: [{ delivery_address_id: "delivery-1" }] };
      if (sql.includes("INSERT INTO clients")) return { rows: [{ client_id: clientId }] };
      return { rows: [] };
    });
    const dto = createClientSchema.parse({
      customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin",
      status: "prospect", blocked: false, creation_date: "2026-10-26", payment_mode_ids: [],
      bill_address: { name: "Facturation", street: "1 rue", postal_code: "42000", city: "Saint-Étienne", country: "France" },
      delivery_address: { name: "Livraison", street: "1 rue", postal_code: "42000", city: "Saint-Étienne", country: "France" },
    });
    await repoCreateClient(dto, audit, null, { client: { query: mocks.query } as never, sideEffects: "none" });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO clients"));
    expect(insert?.[0]).toContain("$1, $2, $3, NULLIF($4,''), NULLIF($5,''), $6");
    expect(insert?.[0]).toContain("$33, $33");
    expect(insert?.[1]?.slice(0, 9)).toEqual(["CLI-001", "Ana Martin", "INDIVIDUAL", "Ana", "Martin", null, "", "", ""]);
    expect(insert?.[1]).toHaveLength(33);
  });

  it("bascule et efface l'identité fiscale dans le même UPDATE", async () => {
    const raw = {
      customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin",
      siret: "", siren: "", vat_number: "", naf_code: "", electronic_address: null,
    };
    const patch = clientPatchSchema.parse(raw);
    await repoPatchClient(clientId, patch, new Set(Object.keys(raw)), audit);

    const update = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE clients SET"));
    expect(update?.[0]).toContain("customer_type = $1");
    expect(update?.[0]).toContain("company_name = $4");
    expect(update?.[0]).toContain("siret = NULLIF($5, '')");
    expect(update?.[0]).toContain("naf_code = NULLIF($8, '')");
    expect(update?.[1]).toEqual([
      "INDIVIDUAL", "Ana", "Martin", "Ana Martin", "", "", "", "", "", "", 1, clientId,
    ]);
  });

  it("ne convertit pas un client historique lorsque customer_type est omis", async () => {
    const raw = { phone: "0478000000" };
    await repoPatchClient(clientId, clientPatchSchema.parse(raw), new Set(Object.keys(raw)), audit);
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE clients SET"));
    expect(update?.[0]).not.toContain("customer_type");
    expect(update?.[0]).not.toContain("individual_first_name");
  });

  it("préserve le type particulier et redérive son libellé sur une édition partielle du nom", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM clients WHERE client_id = $1 FOR UPDATE")) {
        return { rows: [currentClient({ customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin" })] };
      }
      return { rows: [] };
    });
    const raw = { individual_last_name: "Durand" };
    await repoPatchClient(clientId, clientPatchSchema.parse(raw), new Set(Object.keys(raw)), audit);
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE clients SET"));
    expect(update?.[0]).toContain("individual_last_name = NULLIF($1, '')");
    expect(update?.[0]).toContain("company_name = $2");
    expect(update?.[1]).toEqual(["Durand", "Ana Durand", 1, clientId]);
  });
  it("does not replace an individual's derived name with an arbitrary company label", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM clients WHERE client_id = $1 FOR UPDATE") ? [currentClient({ customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin" })] : [] }));
    const raw = { company_name: "Unrelated business" };
    await repoPatchClient(clientId, clientPatchSchema.parse(raw), new Set(Object.keys(raw)), audit);
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE clients SET"));
    expect(update?.[1]?.[0]).toBe("Ana Martin");
  });
  it("rejects fiscal identifiers for a saved individual before attempting an update", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM clients WHERE client_id = $1 FOR UPDATE") ? [currentClient({ customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin" })] : [] }));
    await expect(repoPatchClient(clientId, { siret: "12345678901234" }, new Set(["siret"]), audit)).rejects.toMatchObject({ status: 400, code: "CLIENT_INDIVIDUAL_FISCAL_ID_FORBIDDEN" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE clients SET"))).toBe(false);
  });
  it("requires an explicit business name on conversion and clears personal-name fields atomically", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM clients WHERE client_id = $1 FOR UPDATE") ? [currentClient({ customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin" })] : [] }));
    await expect(repoPatchClient(clientId, { customer_type: "PROFESSIONAL" }, new Set(["customer_type"]), audit)).rejects.toMatchObject({ status: 400, code: "CLIENT_PROFESSIONAL_NAME_REQUIRED" });
    const raw = { customer_type: "PROFESSIONAL", company_name: "Atelier fixture" };
    await repoPatchClient(clientId, clientPatchSchema.parse(raw), new Set(Object.keys(raw)), audit);
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE clients SET"));
    expect(update?.[0]).toContain("individual_first_name = NULL, individual_last_name = NULL");
    expect(update?.[1]).toEqual(["PROFESSIONAL", "Atelier fixture", 1, clientId]);
  });
});
