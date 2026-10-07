import { describe, it, expect, vi } from "vitest";
import { freezeGeneralTerms } from "./commercial-terms.repository";
import { generalTermsReference, termsKind } from "./commercial-terms.domain";
import {
  buildCommandeArContentSnapshot,
  isCommandeArSnapshotCurrent,
} from "../../module/commande-client/domain/commande-ar-fingerprint";

const terms = {
  kind: "CGV" as const,
  document_id: "9124dcd5-1ed2-4562-a0b2-f6af7ee8c79a",
  version_id: "e049c9fc-83b0-4fe2-9bd7-4814e165081b",
  code: "DT-CGV",
  title: "CGV approuvées",
  version_number: 1,
  filename: "CGV.pdf",
  sha256: "a".repeat(64),
  size_bytes: 400,
};
function database(...rows: unknown[][]) {
  return {
    query: vi
      .fn()
      .mockImplementation(async () => ({ rows: rows.shift() ?? [] })),
  };
}

describe("approved general terms issuance", () => {
  it("does not invent conditions before an approved source is configured", async () => {
    expect(
      await freezeGeneralTerms(
        database([], [{ enabled: false }]),
        "devis",
        "1",
        true,
      ),
    ).toBeNull();
  });
  it("requires an explicit selection after approved sources become available", async () => {
    await expect(
      freezeGeneralTerms(database([], [{ enabled: true }]), "devis", "1", true),
    ).rejects.toMatchObject({
      status: 422,
      code: "GENERAL_TERMS_SELECTION_REQUIRED",
    });
  });
  it("still allows saving a draft without a legal selection", async () => {
    const tx = database([]);
    expect(await freezeGeneralTerms(tx, "devis", "1", false)).toBeNull();
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
  it("freezes the selected title and exact hash rather than live metadata", async () => {
    const selected = {
      id: "2e60844d-3c84-4f5d-9635-dd82d1f0d55a",
      snapshot: terms,
    };
    expect(
      await freezeGeneralTerms(
        database([selected], [{ ...terms, title: "Title edited later" }]),
        "devis",
        "1",
        true,
      ),
    ).toEqual(terms);
  });
  it.each([{rows:[]}, {rows:[{ ...terms, sha256: "b".repeat(64) }]}])(
    "rejects an obsolete, unsafe or changed source",
    async ({rows}) => {
      await expect(
        freezeGeneralTerms(
          database([{ snapshot: terms }], rows),
          "devis",
          "1",
          true,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: "GENERAL_TERMS_VERSION_UNAVAILABLE",
      });
    },
  );
  it("selects sales conditions for quotes/AR and purchase conditions for supplier orders", () => {
    expect([
      termsKind("devis"),
      termsKind("commande-client"),
      termsKind("commande-fournisseur"),
    ]).toEqual(["CGV", "CGV", "CGA"]);
    expect(generalTermsReference(terms)).toContain(terms.sha256);
    expect(generalTermsReference(null)).toBeNull();
  });
});

describe("acknowledgement freshness includes attached conditions", () => {
  const source = {
    header: {
      numero: "CMD-1",
      customer_reference: "CLIENT-1",
      statut: "AR_PRET",
      date_commande: "2026-10-07",
      commentaire: null,
      total_ht: 100,
      total_ttc: 120,
      client_company_name: "Client",
      client_email: null,
      client_phone: null,
    },
    lines: [],
  };
  it("makes an unsent AR obsolete after the selected legal revision changes", () => {
    const stored = buildCommandeArContentSnapshot({
      ...source,
      general_terms: terms,
    });
    const current = buildCommandeArContentSnapshot({
      ...source,
      general_terms: {
        ...terms,
        version_id: "f5d6cf2c-6137-489d-9184-1fe26f551970",
      },
    });
    expect(
      isCommandeArSnapshotCurrent({
        storedSnapshot: stored,
        storedFingerprint: null,
        currentSnapshot: current,
      }),
    ).toBe(false);
  });
  it("keeps legacy acknowledgements comparable when neither carries terms", () => {
    const current = buildCommandeArContentSnapshot(source);
    const { general_terms: _ignored, ...legacy } = current;
    expect(
      isCommandeArSnapshotCurrent({
        storedSnapshot: { ...legacy, schema_version: 2 },
        storedFingerprint: null,
        currentSnapshot: current,
      }),
    ).toBe(true);
  });
});
