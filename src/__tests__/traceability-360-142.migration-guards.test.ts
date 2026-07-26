// #142 — Garde-fous de migration : le patch doit rester additif, idempotent,
// transactionnel, et NE JAMAIS fabriquer de traçabilité par backfill déduit.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const patch = read("db/patches/20260726_tracabilite_360_142.sql");
const preflight = read("db/patches/support/20260726_tracabilite_360_142.preflight.sql");
const verify = read("db/patches/support/20260726_tracabilite_360_142.verify.sql");
const rollback = read("db/patches/support/20260726_tracabilite_360_142.rollback.sql");

describe("#142 patch — additif et transactionnel", () => {
  it("est encadré par une transaction explicite", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
  });

  it("ne supprime ni ne réécrit aucune donnée existante", () => {
    expect(patch).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(patch).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+public\./i);
  });

  it("est idempotent (IF NOT EXISTS et gardes pg_constraint)", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.of_material_consumptions");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS");
    expect(patch).toContain("FROM pg_constraint");
    const createIndexCount = (patch.match(/CREATE (UNIQUE )?INDEX /g) ?? []).length;
    const ifNotExistsCount = (patch.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length;
    expect(ifNotExistsCount).toBe(createIndexCount);
  });

  it("n'insère AUCUNE ligne de traçabilité déduite (pas de backfill)", () => {
    // Rapprocher des codes, des dates ou des quantités pour « reconstituer »
    // une consommation, ce serait fabriquer une preuve.
    expect(patch).not.toMatch(/INSERT\s+INTO\s+public\.of_material_consumptions/i);
    expect(patch).not.toMatch(/INSERT\s+INTO\s+public\.traceability_links/i);
    expect(verify).toContain("rows_inserted_by_patch");
  });

  it("ne touche jamais explicitement à la base de production", () => {
    for (const sql of [patch, preflight, verify, rollback]) {
      expect(sql).not.toMatch(/cerp_prod/i);
    }
  });
});

describe("#142 patch — intégrité de la consommation matière", () => {
  it("impose la cohérence article + lot avec la ligne de mouvement", () => {
    expect(patch).toContain("of_material_consumptions_line_article_lot_fk");
    expect(patch).toContain(
      "REFERENCES public.stock_movement_lines(id, article_id, lot_id)"
    );
  });

  it("impose une quantité strictement positive et une unité normalisée", () => {
    expect(patch).toContain("CHECK (qty > 0)");
    expect(patch).toContain("char_length(btrim(unit_code))");
  });

  it("garantit l'idempotence : une ligne de mouvement = une consommation", () => {
    expect(patch).toContain("of_material_consumptions_line_uq");
    expect(patch).toContain("ON public.of_material_consumptions (stock_movement_line_id)");
  });

  it("rend la preuve immuable et impose la compensation", () => {
    expect(patch).toContain("fn_protect_of_material_consumption");
    expect(patch).toContain("trg_protect_of_material_consumption");
    expect(patch).toContain("append-only");
    expect(patch).toContain("compensate instead of deleting");
    expect(patch).toContain("immutable once posted");
  });

  it("interdit qu'une consommation se compense elle-même", () => {
    expect(patch).toContain("of_material_consumptions_not_self_compensation_ck");
  });

  it("n'autorise qu'une seule compensation par consommation", () => {
    expect(patch).toContain("of_material_consumptions_compensates_uq");
  });

  it("restreint les statuts et les sources acceptés", () => {
    expect(patch).toContain("'POSTED', 'COMPENSATED', 'CANCELLED'");
    expect(patch).toContain("'STOCK_MOVEMENT_POST', 'RESERVATION_CONSUME', 'COMPENSATION'");
  });
});

describe("#142 patch — performance et as-built", () => {
  it("indexe les chemins réellement empruntés par le moteur", () => {
    for (const idx of [
      "stock_movements_source_document_idx",
      "stock_reservations_of_consumed_idx",
      "of_operations_of_idx",
      "production_pointages_operation_idx",
      "bon_livraison_ligne_bl_idx",
      "quality_release_decision_control_idx",
      "metrologie_certificats_equipement_date_idx",
      "of_material_consumptions_of_idx",
      "of_material_consumptions_lot_idx",
    ]) {
      expect(patch, idx).toContain(idx);
    }
  });

  it("indexe les codes métier pour la recherche universelle", () => {
    for (const idx of [
      "lots_lot_code_lower_idx",
      "ordres_fabrication_numero_lower_idx",
      "articles_code_lower_idx",
      "bon_livraison_numero_lower_idx",
      "non_conformity_reference_lower_idx",
      "metrologie_equipements_code_lower_idx",
    ]) {
      expect(patch, idx).toContain(idx);
    }
  });

  it("ajoute l'empreinte et le périmètre au dossier as-built", () => {
    expect(patch).toContain("pdf_sha256");
    expect(patch).toContain("pdf_size_bytes");
    expect(patch).toContain("scope_json");
    expect(patch).toContain("as_of");
    expect(patch).toContain("revocation_reason");
    expect(patch).toContain("asbuilt_pack_versions_sha256_ck");
  });

  it("documente que la table de liens historique n'est pas une source de vérité", () => {
    expect(patch).toContain("COMMENT ON TABLE public.traceability_links");
    expect(patch).toMatch(/AUCUN.{0,20}crivain applicatif/i);
    expect(patch).toContain("ADR-0028");
  });

  it("rend la table au rôle applicatif (piège d'ownership documenté)", () => {
    expect(patch).toContain("ALTER TABLE public.of_material_consumptions OWNER TO cerp_app");
    expect(patch).toContain("GRANT SELECT, INSERT, UPDATE");
  });
});

describe("#142 préflight et vérification", () => {
  it("le préflight est en lecture seule", () => {
    expect(preflight).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
  });

  it("le préflight confirme l'absence des objets à créer", () => {
    expect(preflight).toContain("of_material_consumptions");
    expect(preflight).toContain("already_present");
  });

  it("le préflight mesure les preuves de consommation déjà disponibles", () => {
    expect(preflight).toContain("proven_via_reservations");
    expect(preflight).toContain("declared_via_movements");
  });

  it("la vérification contrôle contraintes, trigger, index et ownership", () => {
    expect(verify).toContain("trg_protect_of_material_consumption");
    expect(verify).toContain("of_material_consumptions_line_uq");
    expect(verify).toContain("tableowner");
    expect(verify).toContain("cerp_app");
  });
});

describe("#142 rollback gardé", () => {
  it("refuse de s'exécuter dès qu'une preuve existe", () => {
    expect(rollback).toContain("Rollback refusé");
    expect(rollback).toMatch(/preuve industrielle ne se supprime pas/i);
    expect(rollback).toContain("RAISE EXCEPTION");
  });

  it("ne retire jamais les colonnes d'empreinte as-built", () => {
    expect(rollback).not.toMatch(/DROP\s+COLUMN.*pdf_sha256/i);
    expect(rollback).not.toMatch(/ALTER TABLE public\.asbuilt_pack_versions/i);
  });

  it("est transactionnel", () => {
    expect(rollback).toContain("BEGIN;");
    expect(rollback).toContain("COMMIT;");
  });
});
