import { describe, expect, it } from "vitest";

import {
  buildCommandeArContentSnapshot,
  isCommandeArSnapshotCurrent,
} from "./commande-ar-fingerprint";

const source = {
  header: {
    numero: "CMD-2026-0750",
    customer_reference: "PO-999",
    statut: "AR_PRET",
    date_commande: "2026-08-26",
    commentaire: null,
    total_ht: 100,
    total_ttc: 120,
    client_company_name: "CROIX ROUSSE PRECISION SARL",
    client_email: "lambert@croix-rousse-precision.fr",
    client_phone: null,
    bill_name: "CRP",
    bill_street: "Rue de la Dombes",
    bill_house_number: "530",
    bill_postal_code: "01700",
    bill_city: "MIRIBEL",
    bill_country: "France",
    deliv_name: "CRP",
    deliv_street: "Rue de la Dombes",
    deliv_house_number: "530",
    deliv_postal_code: "01700",
    deliv_city: "MIRIBEL",
    deliv_country: "France",
  },
  lines: [{
    designation: "Rail pare soleil",
    code_piece: "ART-FAB-001",
    quantite: 1,
    unite: "pce",
    prix_unitaire_ht: 100,
    taux_tva: 20,
    total_ttc: 120,
    delai_client: "2026-09-10",
    delai_interne: "2026-09-08",
  }],
};

describe("empreinte documentaire AR", () => {
  it("considère un snapshot v1 identique malgré les timestamps et identifiants techniques", () => {
    const current = buildCommandeArContentSnapshot(source);
    const legacy = {
      schema_version: 1,
      header: { ...current.header, updated_at: "2026-08-26T11:15:03.832746+02" },
      lines: [{ id: 42, ...current.lines[0] }],
      allocations: [{ id: "allocation-1", updated_at: "2026-08-26T11:15:20.414602+02" }],
    };

    expect(isCommandeArSnapshotCurrent({
      storedSnapshot: legacy,
      storedFingerprint: "legacy-hash",
      currentSnapshot: current,
    })).toBe(true);
  });

  it("rend la version obsolète quand un champ visible sur l’AR change", () => {
    const stored = buildCommandeArContentSnapshot(source);
    const current = buildCommandeArContentSnapshot({
      ...source,
      lines: [{ ...source.lines[0], quantite: 2 }],
    });

    expect(isCommandeArSnapshotCurrent({
      storedSnapshot: stored,
      storedFingerprint: null,
      currentSnapshot: current,
    })).toBe(false);
  });
});
