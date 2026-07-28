// #210 — Garde-fous du patch « bibliothèque de finitions ».
//
// Ces tests lisent le SQL livré : ils empêchent qu'un patch cesse d'être
// additif, qu'un backfill s'y glisse, ou qu'un garde-fou structurel disparaisse
// à la faveur d'une retouche.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

// Un script « lecture seule » ne doit contenir aucune INSTRUCTION d'écriture.
// On ancre en début de ligne : `SELECT,INSERT,UPDATE` dans has_table_privilege()
// est un nom de privilège, pas une écriture.
const READ_ONLY = /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im;

const patch = read("db/patches/20260728_surface_finish_library_210.sql");
const preflight = read("db/patches/support/20260728_surface_finish_library_210.preflight.sql");
const verify = read("db/patches/support/20260728_surface_finish_library_210.verify.sql");
const rollback = read("db/patches/support/20260728_surface_finish_library_210.rollback.sql");
const candidates = read("db/patches/support/20260728_surface_finish_library_210.candidates.sql");

describe("#210 patch additif", () => {
  it("est transactionnel", () => {
    expect(patch.trimStart().startsWith("--")).toBe(true);
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
  });

  it("ne détruit ni ne réécrit aucune donnée existante", () => {
    expect(patch).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(patch).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    // Aucune donnée métier existante n'est réécrite : le seul UPDATE toléré
    // serait un backfill, et il n'y en a pas.
    expect(patch).not.toMatch(/\bUPDATE\s+public\.articles\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+public\.articles_traitement\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+public\.pieces_techniques_achats\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+public\.pieces_techniques_operations\b/i);
  });

  it("n'effectue AUCUN backfill : pas de reprise par phase, désignation ou ILIKE", () => {
    expect(patch).not.toMatch(/ILIKE/i);
    expect(patch).not.toMatch(/INSERT INTO public\.gamme_operation_finitions/i);
    // Le seul INSERT de données est l'amorçage du référentiel de familles.
    const inserts = patch.match(/INSERT\s+INTO\s+public\.[a-z_]+/gi) ?? [];
    expect(inserts).toEqual(["INSERT INTO public.surface_finish_families"]);
    expect(patch).toContain("ON CONFLICT (code) DO NOTHING");
  });

  it("ajoute les colonnes en NULLABLE sur les tables existantes", () => {
    for (const column of [
      "spec_fingerprint",
      "spec_canonical",
      "finish_revision_id",
      "generated_designation",
      "superseded_at",
    ]) {
      expect(patch).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${column}\\s+[a-z]+\\s+NULL`, "i"));
    }
    expect(patch).toMatch(/ADD COLUMN IF NOT EXISTS\s+gamme_operation_id\s+uuid NULL/i);
  });

  it("reste idempotent", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.surface_finishes");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.surface_finish_revisions");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.gamme_operation_finitions");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.surface_finish_command_receipts");
    const creates = patch.match(/CREATE TABLE(?! IF NOT EXISTS)/g) ?? [];
    expect(creates).toEqual([]);
    const indexes = patch.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g) ?? [];
    expect(indexes).toEqual([]);
  });
});

describe("#210 garde-fous structurels", () => {
  it("impose une seule version courante d'article par empreinte", () => {
    expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS articles_traitement_fingerprint_current_uq");
    expect(patch).toContain("WHERE spec_fingerprint IS NOT NULL AND superseded_at IS NULL");
  });

  it("lie la ligne d'achat à l'opération par clé étrangère et l'unicité", () => {
    expect(patch).toContain("pt_achats_gamme_operation_fk");
    expect(patch).toContain("FOREIGN KEY (gamme_operation_id) REFERENCES public.pieces_techniques_operations(id)");
    expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS pt_achats_gamme_operation_traitement_uq");
    expect(patch).toContain("type_achat = 'TRAITEMENT'");
  });

  it("n'accepte qu'une exigence de finition par opération et une révision active par finition", () => {
    expect(patch).toContain("CONSTRAINT gamme_operation_finitions_operation_uq UNIQUE (gamme_operation_id)");
    expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS surface_finish_revisions_single_active_uq");
  });

  it("rend le code de finition immuable et contraint son format", () => {
    expect(patch).toContain("fn_protect_surface_finish_code_210");
    expect(patch).toContain("trg_surface_finish_code_immutable");
    expect(patch).toContain("code ~ '^FIN-[0-9]{6}$'");
  });

  it("contraint la cohérence métier en base, pas seulement en TypeScript", () => {
    expect(patch).toContain("surface_finish_revisions_epaisseur_coherente");
    expect(patch).toContain("surface_finish_revisions_certificat_coherent");
    expect(patch).toContain("gamme_operation_finitions_zones_coherentes");
    expect(patch).toContain("gamme_operation_finitions_fingerprint_format");
    expect(patch).toContain("articles_traitement_spec_pair_check");
    expect(patch).toContain("gamme_operation_finitions_override_reason");
  });

  it("empêche la disparition d'une révision utilisée par une gamme", () => {
    expect(patch).toContain(
      "CONSTRAINT gamme_operation_finitions_revision_fk FOREIGN KEY (finish_revision_id)\n    REFERENCES public.surface_finish_revisions(id) ON DELETE RESTRICT"
    );
  });

  it("garde les familles administrables plutôt qu'enfermées dans un enum", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.surface_finish_families");
    expect(patch).not.toMatch(/CHECK\s*\(\s*family_code\s+IN\s*\(/i);
  });

  it("ne stocke aucun chemin de fichier dans le registre documentaire", () => {
    // Aucune COLONNE de chemin : le commentaire de table a le droit d'employer
    // le mot pour dire précisément qu'il n'y en a pas.
    expect(patch).not.toMatch(/^\s*storage_path\s/im);
    expect(patch).not.toMatch(/^\s*(file_path|chemin|filepath)\s/im);
    expect(patch).toContain("surface_finish_revision_documents_anchor_required");
  });

  it("rend les reçus d'idempotence non modifiables par l'application", () => {
    expect(patch).toContain("GRANT SELECT, INSERT ON public.surface_finish_command_receipts TO cerp_app");
    expect(patch).toContain("REVOKE UPDATE, DELETE ON public.surface_finish_command_receipts FROM cerp_app");
  });
});

describe("#210 codification", () => {
  it("ajoute le scope FIN sans retirer aucun scope existant", () => {
    const match = patch.match(/v_scope !~ '(\^\([^']+\)\$)'/);
    expect(match).not.toBeNull();
    const regex = match![1];
    for (const scope of ["CLI", "FOU", "MCH", "MET", "FIN", "BCF", "PC", "DER", "MEX", "MIA"]) {
      expect(regex).toContain(scope);
    }
  });

  it("restaure le whitelist précédent au rollback plutôt que de le laisser amputé", () => {
    expect(rollback).toContain("CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value");
    const match = rollback.match(/v_scope !~ '(\^\([^']+\)\$)'/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("MCH");
    expect(match![1]).toContain("MET");
    expect(match![1]).not.toContain("FIN|");
  });
});

describe("#210 fonctions utilitaires SQL", () => {
  it("expose une normalisation de recherche sans dépendre de l'extension unaccent", () => {
    expect(patch).toContain("CREATE OR REPLACE FUNCTION public.surface_finish_norm");
    expect(patch).not.toMatch(/CREATE EXTENSION/i);
    expect(patch).toContain("IMMUTABLE");
  });

  it("expose la conversion d'épaisseur, miroir du TypeScript", () => {
    expect(patch).toContain("CREATE OR REPLACE FUNCTION public.surface_finish_to_um");
    for (const factor of ["1000", "10000", "25400", "25.4"]) {
      expect(patch).toContain(factor);
    }
  });

  it("indexe ce que la recherche interroge réellement", () => {
    expect(patch).toContain("public.surface_finish_norm(designation_courte)");
    expect(patch).toContain("public.surface_finish_norm(norme)");
    expect(patch).toContain("USING gin (synonymes)");
  });
});

describe("#210 preflight", () => {
  it("est en lecture seule", () => {
    expect(preflight).not.toMatch(READ_ONLY);
  });

  it("vérifie les pré-requis et l'absence des tables du chantier", () => {
    expect(preflight).toContain("req_code_allocator");
    expect(preflight).toContain("cat_traitement_surface_present");
    expect(preflight).toContain("t_finishes_absent");
    expect(preflight).toContain("col_achat_operation_absent");
    expect(preflight).toContain("articles_rows_before");
  });
});

describe("#210 verify", () => {
  it("est en lecture seule et ne consomme aucune séquence", () => {
    expect(verify).not.toMatch(READ_ONLY);
    expect(verify).not.toMatch(/SELECT public\.fn_next_issued_code_value\(/);
  });

  it("prouve l'absence de backfill", () => {
    expect(verify).toContain("backfilled_fingerprints");
    expect(verify).toContain("backfilled_achat_links");
    expect(verify).toContain("articles_rows_after");
  });

  it("prouve que l'enum du catalogue fournisseur n'a pas bougé", () => {
    expect(verify).toContain("supplier_catalogue_enum_untouched");
  });

  it("contrôle les garde-fous et les droits", () => {
    expect(verify).toContain("idx_fingerprint_unique");
    expect(verify).toContain("idx_achat_operation_unique");
    expect(verify).toContain("trg_code_immutable");
    expect(verify).toContain("grants_ok");
  });
});

describe("#210 rollback réaliste", () => {
  it("refuse de s'exécuter si des données métier existent", () => {
    expect(rollback).toContain("Rollback refusé");
    expect(rollback).toContain("cerp.force_rollback");
    expect(rollback).toContain("ERRCODE = '2F000'");
  });

  it("dit explicitement qu'il détruit et ne restaure rien", () => {
    expect(rollback).toMatch(/DÉTRUIT/);
    expect(rollback).toMatch(/sauvegarde/i);
  });

  it("ne supprime ni les articles ni les lignes d'achat existantes", () => {
    expect(rollback).not.toMatch(/DROP TABLE IF EXISTS public\.articles\b/i);
    expect(rollback).not.toMatch(/DROP TABLE IF EXISTS public\.pieces_techniques_achats\b/i);
    expect(rollback).not.toMatch(/DELETE FROM public\.articles\b/i);
  });
});

describe("#210 rapport de reprise historique", () => {
  it("est en lecture seule et ne relie rien automatiquement", () => {
    expect(candidates).not.toMatch(READ_ONLY);
    expect(candidates).toMatch(/AUCUN BACKFILL/);
  });

  it("classe les candidats en quatre familles explicites", () => {
    for (const label of ["EXACT_PROBABLE", "AMBIGU", "INCOMPATIBLE", "NON_LIE"]) {
      expect(candidates).toContain(label);
    }
  });

  it("rappelle que le numéro de phase n'est pas un lien", () => {
    expect(candidates).toMatch(/phase N'EST PAS un lien/);
  });
});
