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
    });
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
});
