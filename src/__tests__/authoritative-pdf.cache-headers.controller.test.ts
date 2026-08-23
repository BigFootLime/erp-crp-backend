import { beforeEach, describe, expect, it, vi } from "vitest";

const supplier = vi.hoisted(() => ({ read: vi.fn() }));
const quote = vi.hoisted(() => ({ read: vi.fn() }));
const acknowledgement = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("../module/commande-fournisseur/services/commande-fournisseur.service", () => ({
  readSupplierPoOfficialDocumentSVC: supplier.read,
}));
vi.mock("../module/devis/services/devis.service", () => ({
  svcReadDevisOfficialDocument: quote.read,
}));
vi.mock("../module/commande-client/services/commande-ar.service", () => ({
  svcReadCommandeArOfficialDocument: acknowledgement.read,
}));

import { downloadOfficialDocument, previewOfficialDocument } from "../module/commande-fournisseur/controllers/commande-fournisseur.controller";
import { downloadDevisOfficialDocument, previewDevisOfficialDocument } from "../module/devis/controllers/devis.controller";
import { downloadAcknowledgement, previewAcknowledgement } from "../module/commande-client/controllers/commande-ar.controller";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const SUPPLIER_ID = "22222222-2222-4222-8222-222222222222";
const bytes = Buffer.from("%PDF-1.7 authoritative");

function responseDouble() {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    send: vi.fn(),
  };
}

const endpoints = [
  { label: "supplier PO preview", handler: previewOfficialDocument, params: { id: SUPPLIER_ID, documentId: DOCUMENT_ID }, reader: supplier.read, disposition: "inline" },
  { label: "supplier PO download", handler: downloadOfficialDocument, params: { id: SUPPLIER_ID, documentId: DOCUMENT_ID }, reader: supplier.read, disposition: "attachment" },
  { label: "quote preview", handler: previewDevisOfficialDocument, params: { id: "42", documentId: DOCUMENT_ID }, reader: quote.read, disposition: "inline" },
  { label: "quote download", handler: downloadDevisOfficialDocument, params: { id: "42", documentId: DOCUMENT_ID }, reader: quote.read, disposition: "attachment" },
  { label: "acknowledgement preview", handler: previewAcknowledgement, params: { id: "42", documentId: DOCUMENT_ID }, reader: acknowledgement.read, disposition: "inline" },
  { label: "acknowledgement download", handler: downloadAcknowledgement, params: { id: "42", documentId: DOCUMENT_ID }, reader: acknowledgement.read, disposition: "attachment" },
] as const;

describe("authoritative PDF delivery cache policy", () => {
  beforeEach(() => {
    supplier.read.mockReset().mockResolvedValue({ bytes, filename: "supplier-po.pdf" });
    quote.read.mockReset().mockResolvedValue({ bytes, filename: "quote.pdf" });
    acknowledgement.read.mockReset().mockResolvedValue({ bytes, filename: "acknowledgement.pdf" });
  });

  it.each(endpoints)("sets private no-store while preserving PDF delivery headers for $label", async ({ handler, params, disposition }) => {
    const res = responseDouble();
    const next = vi.fn();
    const req = {
      params,
      headers: {},
      user: { id: 7, role: "Administrateur" },
      ip: "127.0.0.1",
      originalUrl: "/authoritative-pdf-test",
    };

    await (handler as unknown as (req: typeof req, res: typeof res, next: typeof next) => Promise<void>)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain(disposition);
    expect(res.send).toHaveBeenCalledWith(bytes);
  });
});
