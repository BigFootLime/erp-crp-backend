import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { IMPORT_CAPABILITIES } from "../module/import-assistant/domain/import-capabilities";
import {
  assertImportAssistantDatabase,
  IMPORT_ASSISTANT_DATABASE,
} from "../module/import-assistant/domain/import-database-guard";
import {
  importRowDedupeKeys,
  normalizeImportRow,
  validateMapping,
} from "../module/import-assistant/domain/import-normalization";
import { parseTabularFile } from "../module/import-assistant/domain/tabular-file-parser";
import type { ImportMapping } from "../module/import-assistant/types/import-assistant.types";

function uploadFile(name: string, body: string) {
  const buffer = Buffer.from(body, "utf8");
  return {
    originalname: name,
    mimetype: "text/csv",
    buffer,
    size: buffer.byteLength,
  } as Express.Multer.File;
}

function storedZip(entries: Array<{ name: string; body: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = Buffer.from(entry.body, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function namespacedXlsxFile(worksheetTarget = "/xl/worksheets/sheet1.xml"): Express.Multer.File {
  const serial = Math.round(
    (Date.UTC(2026, 6, 27) - Date.UTC(1899, 11, 30)) / 86_400_000
  );
  const buffer = storedZip([
    {
      name: "xl/workbook.xml",
      body: `<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheets><x:sheet name="Pilote" sheetId="1" r:id="R1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></x:sheets></x:workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      body: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${worksheetTarget}" Id="R1"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      body: `<?xml version="1.0"?><x:styleSheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:cellXfs count="2"><x:xf numFmtId="0"/><x:xf numFmtId="14"/></x:cellXfs></x:styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      body: `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>legacy_code</x:v></x:c><x:c r="B1" t="str"><x:v>email</x:v></x:c><x:c r="C1" t="str"><x:v>siret</x:v></x:c><x:c r="D1" t="str"><x:v>creation_date</x:v></x:c></x:row><x:row r="2"><x:c r="A2" t="str"><x:v>001</x:v></x:c><x:c r="B2"/><x:c r="C2" t="str"><x:v>10539713700016</x:v></x:c><x:c r="D2" s="1"><x:v>${serial}</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    },
  ]);
  return {
    originalname: "pilote-prefixe.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
    size: buffer.length,
  } as Express.Multer.File;
}

describe("Assistant d’import CLIPPER", () => {
  it("lit les CSV français avec guillemets, séparateurs et lignes vides", () => {
    const parsed = parseTabularFile(uploadFile(
      "FOURNISSEUR.csv",
      "\uFEFFCODE;NOM;NOTE\r\nF001;Atelier Alpha;\"Usinage; contrôle\"\r\n\r\n"
    ));

    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].headers).toEqual(["CODE", "NOM", "NOTE"]);
    expect(parsed.sheets[0].rows).toEqual([
      { CODE: "F001", NOM: "Atelier Alpha", NOTE: "Usinage; contrôle" },
    ]);
  });

  it("refuse un format qui ne passe pas par le parseur contrôlé", () => {
    expect(() => parseTabularFile(uploadFile("legacy.xls", "CODE\tNOM"))).toThrow(
      "Format refusé"
    );
  });

  it("lit les XLSX avec espaces de noms préfixés et relations de partie absolues", () => {
    const parsed = parseTabularFile(namespacedXlsxFile());

    expect(parsed.sheets).toEqual([
      {
        name: "Pilote",
        headers: ["legacy_code", "email", "siret", "creation_date"],
        rows: [
          {
            legacy_code: "001",
            email: null,
            siret: "10539713700016",
            creation_date: "2026-07-27",
          },
        ],
      },
    ]);
  });

  it("continue de refuser une relation XLSX qui sort de l’archive", () => {
    expect(() => parseTabularFile(namespacedXlsxFile("/../outside.xml"))).toThrow(
      "Chemin de feuille XLSX interdit"
    );
  });

  it("exige la référence CLIPPER et tous les champs obligatoires", () => {
    const mapping: ImportMapping = {
      legacy_key_column: "",
      columns: { company_name: "NOM" },
      constants: {},
      approved_decisions: [],
      duplicate_strategy: "REVIEW",
    };

    const issues = validateMapping("CLIENT", ["CODE", "NOM"], mapping);

    expect(issues.map((issue) => issue.code)).toContain("LEGACY_KEY_REQUIRED");
    expect(issues.map((issue) => issue.field)).toContain("status");
    expect(issues.map((issue) => issue.field)).toContain("bill_address.street");
  });

  it("normalise les booléens et conserve les clés fortes de dédoublonnage", () => {
    const mapping: ImportMapping = {
      legacy_key_column: "CODE",
      columns: {
        name: "NOM",
        type: "TYPE",
        serial_number: "SERIE",
        scheduling_enabled: "PLANIFIABLE",
      },
      constants: {},
      approved_decisions: ["DEC-07", "DEC-14", "DEC-15"],
      duplicate_strategy: "LINK_EXACT",
    };
    const result = normalizeImportRow(
      "MACHINE",
      {
        CODE: "MC-12",
        NOM: "DMG MORI 1",
        TYPE: "MILLING",
        SERIE: "SN-00012",
        PLANIFIABLE: "oui",
      },
      mapping
    );

    expect(result.issues).toEqual([]);
    expect(result.legacy_key).toBe("MC-12");
    expect(result.normalized_data).toMatchObject({ scheduling_enabled: true });
    expect(importRowDedupeKeys("MACHINE", result.normalized_data!)).toEqual({
      siret: null,
      secondary: "SN-00012",
      name: null,
    });
  });

  it("normalise le nom métier comme dédoublonnage exact de revue", () => {
    expect(importRowDedupeKeys("CLIENT", {
      company_name: "Électro Méca Gonin",
      siret: null,
      vat_number: null,
    })).toEqual({
      siret: null,
      secondary: null,
      name: "ELECTROMECAGONIN",
    });
    expect(importRowDedupeKeys("FOURNISSEUR", {
      nom: "Aciéries & Rives",
      siret: null,
      tva: null,
    })).toEqual({
      siret: null,
      secondary: null,
      name: "ACIERIESRIVES",
    });
  });

  it("enrichit un client sans injecter de listes vides ni effacer les champs absents", () => {
    const mapping: ImportMapping = {
      legacy_key_column: "CODE",
      columns: {
        company_name: "NOM",
        email: "EMAIL",
        compte_tiers: "COMPTE",
      },
      constants: {},
      approved_decisions: ["DEC-04", "DEC-14", "DEC-15"],
      duplicate_strategy: "LINK_EXACT",
    };

    const result = normalizeImportRow(
      "CLIENT_ENRICHISSEMENT",
      {
        CODE: "C00042",
        NOM: "Client enrichi",
        EMAIL: "contact@example.fr",
        COMPTE: "411C00042",
      },
      mapping
    );

    expect(result.issues).toEqual([]);
    expect(result.normalized_data).toEqual({
      company_name: "Client enrichi",
      email: "contact@example.fr",
      compte_tiers: "411C00042",
    });
    expect(result.normalized_data).not.toHaveProperty("contacts");
    expect(result.normalized_data).not.toHaveProperty("payment_mode_ids");
    expect(result.normalized_data).not.toHaveProperty("quality_levels");
  });

  it("valide un contact client avec sa clé parent et bloque les coordonnées incomplètes", () => {
    const mapping: ImportMapping = {
      legacy_key_column: "CONTACT_KEY",
      columns: {
        client_legacy_code: "CLIENT_CODE",
        first_name: "PRENOM",
        last_name: "NOM",
        email: "EMAIL",
        set_primary: "PRINCIPAL",
      },
      constants: {},
      approved_decisions: ["DEC-04", "DEC-14", "DEC-15"],
      duplicate_strategy: "REVIEW",
    };

    const valid = normalizeImportRow(
      "CLIENT_CONTACT",
      {
        CONTACT_KEY: "C00042|1",
        CLIENT_CODE: "C00042",
        PRENOM: "Alice",
        NOM: "Martin",
        EMAIL: "alice.martin@example.fr",
        PRINCIPAL: "oui",
      },
      mapping
    );
    const blocked = normalizeImportRow(
      "CLIENT_CONTACT",
      {
        CONTACT_KEY: "C00042|2",
        CLIENT_CODE: "C00042",
        PRENOM: "",
        NOM: "Martin",
        EMAIL: "",
      },
      mapping
    );

    expect(valid.issues).toEqual([]);
    expect(valid.normalized_data).toMatchObject({
      client_legacy_code: "C00042",
      first_name: "Alice",
      last_name: "Martin",
      email: "alice.martin@example.fr",
      set_primary: true,
    });
    expect(blocked.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["first_name", "email"])
    );
  });

  it("présente les pièces techniques après les référentiels et les flux d'achat", () => {
    const ordered = [...IMPORT_CAPABILITIES].sort((a, b) => a.order - b.order);
    const clientEnrichment = ordered.findIndex((item) => item.entity_type === "CLIENT_ENRICHISSEMENT");
    const clientContacts = ordered.findIndex((item) => item.entity_type === "CLIENT_CONTACT");
    const suppliers = ordered.findIndex((item) => item.entity_type === "FOURNISSEUR");
    const supplierOrders = ordered.findIndex((item) => item.entity_type === "FOURNISSEUR_COMMANDE");
    const articles = ordered.findIndex((item) => item.entity_type === "ARTICLE");
    const pieces = ordered.findIndex((item) => item.entity_type === "PIECE_TECHNIQUE");

    expect(clientEnrichment).toBeLessThan(clientContacts);
    expect(clientContacts).toBeLessThan(suppliers);
    expect(suppliers).toBeLessThan(supplierOrders);
    expect(supplierOrders).toBeLessThan(articles);
    expect(articles).toBeLessThan(pieces);
  });

  it("marque l’adresse fournisseur importée comme adresse principale", () => {
    const mapping: ImportMapping = {
      legacy_key_column: "CODE",
      columns: {
        nom: "NOM",
        "adresse.type": "ADRESSE_TYPE",
        "adresse.label": "ADRESSE_LABEL",
        "adresse.city": "VILLE",
        "adresse.country": "PAYS",
      },
      constants: {},
      approved_decisions: ["DEC-03", "DEC-14", "DEC-15"],
      duplicate_strategy: "REVIEW",
    };
    const result = normalizeImportRow(
      "FOURNISSEUR",
      {
        CODE: "F001",
        NOM: "Fournisseur pilote",
        ADRESSE_TYPE: "commande",
        ADRESSE_LABEL: "Fournisseur pilote",
        VILLE: "Lyon",
        PAYS: "France",
      },
      mapping
    );

    expect(result.issues).toEqual([]);
    expect(result.normalized_data).toMatchObject({
      adresses: [{
        type: "commande",
        label: "Fournisseur pilote",
        city: "Lyon",
        country: "France",
        is_primary: true,
      }],
    });
  });

  it("normalise une commande fournisseur ouverte avec ses lignes contrôlées", () => {
    const mapping: ImportMapping = {
      legacy_key_column: "BC",
      columns: {
        fournisseur_legacy_code: "FOURNISSEUR",
        date_commande_source: "DATE_COMMANDE",
        devise: "DEVISE",
        date_besoin: "DATE_BESOIN",
        note_interne: "NOTE",
        lignes_json: "LIGNES_JSON",
      },
      constants: {},
      approved_decisions: ["DEC-03", "DEC-14", "DEC-15", "DEC-17"],
      duplicate_strategy: "REVIEW",
    };
    const result = normalizeImportRow(
      "FOURNISSEUR_COMMANDE",
      {
        BC: "4542",
        FOURNISSEUR: "F272",
        DATE_COMMANDE: "22/07/2026",
        DEVISE: "EUR",
        DATE_BESOIN: "29/07/2026",
        NOTE: "Commande ouverte au cut-off.",
        LIGNES_JSON: JSON.stringify([{
          type: "PRESTATION",
          reference_fournisseur: "TS-45",
          designation: "SHERARDISATION 45µM",
          unite: "PC",
          quantite: 12,
          prix_unitaire_ht: 4.5,
          tva_pct: 20,
          date_besoin: "2026-07-29",
          exigences_qualite: [],
          documents_attendus: [],
          besoins: [],
        }]),
      },
      mapping
    );

    expect(result.issues).toEqual([]);
    expect(result.normalized_data).toMatchObject({
      fournisseur_legacy_code: "F272",
      date_commande_source: "2026-07-22",
      devise: "EUR",
      date_besoin: "2026-07-29",
      note_interne: "Migration CLIPPER — BC 4542 du 2026-07-22\nCommande ouverte au cut-off.",
      lignes: [{
        type: "PRESTATION",
        designation: "SHERARDISATION 45µM",
        quantite: 12,
      }],
    });
    expect(result.normalized_data).not.toHaveProperty("lignes_json");
  });

  it("bloque une commande fournisseur dont les lignes JSON sont invalides", () => {
    const mapping: ImportMapping = {
      legacy_key_column: "BC",
      columns: {
        fournisseur_legacy_code: "FOURNISSEUR",
        date_commande_source: "DATE_COMMANDE",
        devise: "DEVISE",
        lignes_json: "LIGNES_JSON",
      },
      constants: {},
      approved_decisions: ["DEC-03", "DEC-14", "DEC-15", "DEC-17"],
      duplicate_strategy: "REVIEW",
    };
    const result = normalizeImportRow(
      "FOURNISSEUR_COMMANDE",
      {
        BC: "4542",
        FOURNISSEUR: "F272",
        DATE_COMMANDE: "2026-07-22",
        DEVISE: "EUR",
        LIGNES_JSON: "{invalide",
      },
      mapping
    );

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_LINES_JSON", field: "lignes_json" }),
    ]));
  });

  it("garde stock, BL et RH visibles mais impossibles à confirmer", () => {
    const gated = IMPORT_CAPABILITIES.filter((capability) =>
      ["STOCK_INITIAL", "BL_HISTORIQUE", "EMPLOYE"].includes(capability.entity_type)
    );

    expect(gated).toHaveLength(3);
    expect(gated.every((capability) => !capability.confirm_enabled)).toBe(true);
    expect(gated.every((capability) => capability.unavailable_reason)).toBe(true);
  });

  it("verrouille toutes les routes sur la connexion réelle cerp_test", () => {
    expect(IMPORT_ASSISTANT_DATABASE).toBe("cerp_test");
    expect(() => assertImportAssistantDatabase("cerp_test")).not.toThrow();
    expect(() => assertImportAssistantDatabase("cerp_prod")).toThrow(
      "verrouillé sur la base de validation cerp_test"
    );
    expect(() => assertImportAssistantDatabase(undefined)).toThrow(
      "verrouillé sur la base de validation cerp_test"
    );
  });

  it("garde la migration additive, idempotente et soumise à rétention", () => {
    const patch = fs.readFileSync(
      path.resolve(process.cwd(), "db/patches/20260726_import_assistant_167.sql"),
      "utf8"
    );
    expect(patch).toContain("data_import_crosswalk_source_uq");
    expect(patch).toContain("data_import_confirm_idempotency");
    expect(patch).toContain("fn_purge_expired_import_staging");
    expect(patch).toContain("retention_until date NOT NULL DEFAULT (CURRENT_DATE + 90)");
    expect(patch).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it("ajoute les imports clients spécialisés et l'idempotence des contacts", () => {
    const patch = fs.readFileSync(
      path.resolve(process.cwd(), "db/patches/20260727_import_clients_enrichment_306.sql"),
      "utf8"
    );

    expect(patch).toContain("'CLIENT_ENRICHISSEMENT'");
    expect(patch).toContain("'CLIENT_CONTACT'");
    expect(patch).toContain("client_contact_create_idempotency");
    expect(patch).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it("ouvre les commandes fournisseurs uniquement via le patch cerp_test", () => {
    const patch = fs.readFileSync(
      path.resolve(process.cwd(), "db/patches/20260727_import_supplier_orders_312.sql"),
      "utf8"
    );

    expect(patch).toContain("current_database() <> 'cerp_test'");
    expect(patch).toContain("'FOURNISSEUR_COMMANDE'");
    expect(patch).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("porte l'unicité du courriel de contact au niveau du client actif", () => {
    const patch = fs.readFileSync(
      path.resolve(process.cwd(), "db/patches/20260727_contacts_email_scope_187.sql"),
      "utf8"
    );

    expect(patch).toContain("current_database() <> 'cerp_test'");
    expect(patch).toContain("DROP CONSTRAINT IF EXISTS contacts_email_key");
    expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS contacts_client_email_active_key");
    expect(patch).toContain("client_id, lower(btrim(email))");
    expect(patch).toContain("archived_at IS NULL");
    expect(patch).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("autorise un courriel fonctionnel partagé par des personnes distinctes du même client", () => {
    const patch = fs.readFileSync(
      path.resolve(process.cwd(), "db/patches/20260727_contacts_shared_email_identity_190.sql"),
      "utf8"
    );

    expect(patch).toContain("current_database() <> 'cerp_test'");
    expect(patch).toContain("DROP INDEX IF EXISTS public.contacts_client_email_active_key");
    expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS contacts_client_email_identity_active_key");
    expect(patch).toContain("lower(btrim(coalesce(first_name, '')))");
    expect(patch).toContain("lower(btrim(coalesce(last_name, '')))");
    expect(patch).toContain("archived_at IS NULL");
    expect(patch).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/i);
  });
});
