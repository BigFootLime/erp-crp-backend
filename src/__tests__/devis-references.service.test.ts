import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  listClients: vi.fn(),
  getClient: vi.fn(),
  getClientQuoteReference: vi.fn(),
  listAddresses: vi.fn(),
  listContacts: vi.fn(),
  listPieces: vi.fn(),
  listBillers: vi.fn(),
  listPaymentModes: vi.fn(),
}));

vi.mock("../module/client/services/clients.read.service", () => ({
  svcListClients: dependencies.listClients,
  svcGetClientById: dependencies.getClient,
  svcListClientAddresses: dependencies.listAddresses,
}));
vi.mock("../module/client/services/client.service", () => ({ listClientContacts: dependencies.listContacts, getClientQuoteReferenceById: dependencies.getClientQuoteReference }));
vi.mock("../module/pieces-techniques/services/pieces-techniques.service", () => ({ listPieceTechniquesSVC: dependencies.listPieces }));
vi.mock("../module/biller/services/billers.service", () => ({ svcListBillers: dependencies.listBillers }));
vi.mock("../module/payment-mode/services/payment-modes.service", () => ({ svcListPaymentModes: dependencies.listPaymentModes }));

import {
  getDevisClientReference,
  listDevisClientContacts,
  listDevisClientReferences,
  listDevisPieceTechniqueReferences,
} from "../module/devis/services/devis-references.service";

describe("quote reference projections", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns a minimal client selector without generic client contact data", async () => {
    dependencies.listClients.mockResolvedValue([{ client_id: "c1", client_code: "ACME", company_name: "Acme", status: "ACTIVE", blocked: false, email: "private@example.test" }]);
    await expect(listDevisClientReferences({ q: "ac", limit: "5" })).resolves.toEqual([
      { client_id: "c1", client_code: "ACME", company_name: "Acme", status: "ACTIVE", blocked: false },
    ]);
    expect(dependencies.listClients).toHaveBeenCalledWith("ac", 5);
  });

  it("keeps only the safe logo asset identity needed by a quote document", async () => {
    dependencies.getClientQuoteReference.mockResolvedValue({ client_id: "c1", client_code: "ACME", company_name: "Acme", status: "ACTIVE", blocked: false, logo_asset: { asset_id: "asset", status: "AVAILABLE" } });
    dependencies.getClient.mockResolvedValue({ biller: null, bill_address: null, delivery_address: null, payment_modes: [] });
    await expect(getDevisClientReference("c1")).resolves.toMatchObject({
      client: { client_id: "c1", logo_asset: { asset_id: "asset", status: "AVAILABLE" } },
    });
  });
  it("does not project personal contact phone numbers into a quote", async () => {
    dependencies.listContacts.mockResolvedValue([{
      contact_id: "contact", first_name: "A", last_name: "B", email: "a@example.test", phone_direct: "01", phone_personal: "06", role: "Buyer", civility: null, label: "A B",
    }]);
    await expect(listDevisClientContacts("client")).resolves.toEqual([{
      contact_id: "contact", first_name: "A", last_name: "B", email: "a@example.test", phone_direct: "01", role: "Buyer", civility: null, label: "A B",
    }]);
    expect(dependencies.listContacts).toHaveBeenCalledWith("client", { includePersonalPhone: false });
  });

  it("keeps the quote line fields needed to apply a technical piece", async () => {
    dependencies.listPieces.mockResolvedValue({ items: [{ id: "piece", code_piece: "P-1", designation: "Pièce", designation_2: "D2", client_id: "client", client_name: "Acme", prix_unitaire: 12, article_id: "article" }], total: 1 });
    await expect(listDevisPieceTechniqueReferences({ q: "P" })).resolves.toEqual([{
      id: "piece", code_piece: "P-1", designation: "Pièce", designation_2: "D2", client_id: "client", client_name: "Acme", prix_unitaire: 12, article_id: "article", version_id: null,
    }]);
  });

  it("uses the bounded reference limit", async () => {
    dependencies.listClients.mockResolvedValue([]);
    await listDevisClientReferences({ limit: "999" });
    expect(dependencies.listClients).toHaveBeenCalledWith("", 100);
  });

  it("returns 404 when the selected client no longer exists", async () => {
    dependencies.getClientQuoteReference.mockResolvedValue(null);
    await expect(getDevisClientReference("missing")).rejects.toMatchObject({ status: 404, code: "CLIENT_NOT_FOUND" });
  });
});
