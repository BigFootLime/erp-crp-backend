import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();

  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Administrateur Systeme et Reseau" };
    next();
  },
  authorizeRole:
    (..._roles: string[]) =>
    (_req: unknown, _res: unknown, next: () => void) => {
      next();
    },
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("/api/v1/clients", () => {
  it("GET /api/v1/clients returns client_code in the list payload", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          client_id: "45",
          client_code: "CLI-045",
          company_name: "ACME SAS",
          email: "contact@acme.test",
          phone: null,
          website_url: null,
          siret: null,
          vat_number: null,
          naf_code: null,
          status: "client",
          blocked: false,
          reason: null,
          creation_date: "2026-03-18",
          observations: null,
          provided_documents_id: null,
          quality_level: null,
          quality_levels: [],
          logo_path: null,
          delivery_address_id: null,
          bill_address_id: null,
          biller_id: null,
          bill_name: null,
          bill_street: null,
          bill_house_number: null,
          bill_postal_code: null,
          bill_city: null,
          bill_country: null,
          deliv_name: null,
          deliv_street: null,
          deliv_house_number: null,
          deliv_postal_code: null,
          deliv_city: null,
          deliv_country: null,
          bank_name: null,
          iban: null,
          bic: null,
          contact_first_name: null,
          contact_last_name: null,
          contact_email: null,
          contact_phone_personal: null,
          contact_role: null,
          contact_civility: null,
          contacts: [],
          payment_mode_ids: [],
          payment_mode_labels: [],
        },
      ],
    });

    const res = await request(app).get("/api/v1/clients").query({ limit: "1" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      client_id: "45",
      client_code: "CLI-045",
      company_name: "ACME SAS",
    });
  });

  it("GET /api/v1/clients/:id returns client.client_code in detail payload", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            client_id: "45",
            client_code: "CLI-045",
            company_name: "ACME SAS",
            email: "contact@acme.test",
            phone: null,
            website_url: null,
            siret: null,
            vat_number: null,
            naf_code: null,
            status: "client",
            blocked: false,
            reason: null,
            creation_date: "2026-03-18",
            observations: null,
            provided_documents_id: null,
            biller_id: null,
            biller_name: null,
            bill_address_id: "bill-1",
            bill_name: "Facturation",
            bill_street: "1 rue de Lyon",
            bill_house_number: null,
            bill_postal_code: "69001",
            bill_city: "Lyon",
            bill_country: "France",
            delivery_address_id: "deliv-1",
            deliv_name: "Livraison",
            deliv_street: "2 rue de Marseille",
            deliv_house_number: null,
            deliv_postal_code: "69002",
            deliv_city: "Lyon",
            deliv_country: "France",
            bank_info_id: "bank-1",
            bank_name: "Banque Test",
            iban: "FR7612345678901234567890123",
            bic: "AGRIFRPP",
            contact_id: "contact-1",
            first_name: "Camille",
            last_name: "Martin",
            civility: "Mme",
            role: "Achats",
            phone_personal: "0102030405",
            contact_email: "camille@acme.test",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/api/v1/clients/45");

    expect(res.status).toBe(200);
    expect(res.body.client).toMatchObject({
      client_id: "45",
      client_code: "CLI-045",
      company_name: "ACME SAS",
    });
  });
});
