// #274 — Garde-fous du patch de base de données.
// Le patch est lu comme du texte : ces tests interdisent qu'une évolution
// future le rende destructif, non rejouable, ou qu'elle casse la garantie
// anti-double-comptage.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const PATCH = path.join(repoRoot, "db", "patches", "20260726_production_execution_274.sql");
const SUPPORT = path.join(repoRoot, "db", "patches", "support");

const sql = fs.readFileSync(PATCH, "utf8");

/**
 * Corps du patch débarrassé des blocs `$$ ... $$` : un UPDATE écrit DANS une
 * fonction n'est pas exécuté par la migration, il est seulement défini. La
 * distinction est essentielle — sinon le test interdirait d'écrire la fonction
 * de recalcul elle-même.
 */
const executedStatements = sql.replace(/\$\$[\s\S]*?\$\$/g, " /* body */ ");

describe("#274 patch — additif et non destructif", () => {
  it("ne supprime aucune table ni colonne existante", () => {
    // Le patch principal n'a AUCUNE raison de supprimer quoi que ce soit :
    // tout retour arrière passe par le fichier de rollback dédié.
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("ne réécrit aucune donnée métier existante", () => {
    // Aucun UPDATE EXÉCUTÉ : le patch ne recalcule ni ne corrige l'historique.
    // La reprise du sous-comptage est une décision humaine, pas un effet de
    // bord de migration. Les UPDATE définis dans le corps des fonctions sont
    // exclus : ils ne s'exécutent qu'à l'appel, par le service.
    expect(executedStatements).not.toMatch(
      /\bUPDATE\s+public\.(production_pointages|of_time_logs|of_operations|ordres_fabrication)\b/i
    );
  });

  it("n'insère que des données de référentiel, jamais de données métier", () => {
    const inserts = executedStatements.match(/INSERT\s+INTO\s+public\.(\w+)/gi) ?? [];
    for (const insert of inserts) {
      expect(insert.toLowerCase()).toContain("production_activity_categories");
    }
  });

  it("est transactionnel", () => {
    // BEGIN doit précéder la première instruction exécutable, et COMMIT clore
    // le fichier : sinon un échec en cours de route laisserait un état partiel.
    const begin = sql.indexOf("\nBEGIN;");
    const firstDdl = sql.search(/\n(CREATE|ALTER|INSERT|DO)\b/);
    expect(begin).toBeGreaterThan(-1);
    expect(firstDdl).toBeGreaterThan(begin);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("est idempotent", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/ON CONFLICT \(code\) DO NOTHING/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/);
    // Les contraintes sont posées sous garde d'existence.
    expect(sql).toMatch(/SELECT 1 FROM pg_constraint WHERE conname/);
  });

  it("vérifie ses pré-requis avant de modifier quoi que ce soit", () => {
    for (const table of [
      "public.production_pointages",
      "public.production_pointage_events",
      "public.of_operations",
      "public.of_time_logs",
    ]) {
      expect(sql).toContain(`to_regclass('${table}') IS NULL`);
    }
  });
});

describe("#274 patch — garantie anti-double-comptage", () => {
  it("crée la colonne de corrélation of_time_logs.pointage_id", () => {
    expect(sql).toMatch(/ALTER TABLE public\.of_time_logs[\s\S]*ADD COLUMN IF NOT EXISTS pointage_id uuid/);
  });

  it("exclut du résidu legacy toute ligne déjà comptée côté canonique", () => {
    // C'est LA ligne qui empêche la double comptabilisation.
    expect(sql).toMatch(/FROM public\.of_time_logs t[\s\S]*?t\.pointage_id IS NULL/);
  });

  it("miroite les routes legacy dans la même transaction PostgreSQL", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.tg_production_mirror_legacy_time_log/);
    expect(sql).toMatch(/CREATE TRIGGER production_mirror_legacy_time_log/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF ended_at, comment/);
    expect(sql).toMatch(/NEW\.pointage_id := v_pointage_id/);
    expect(sql).toMatch(/'LEGACY_TIME_LOG'/);
  });

  it("ne compte côté canonique que les segments réellement terminés", () => {
    // CANCELLED et CORRECTED ne doivent jamais gonfler le temps réel.
    expect(sql).toMatch(/p\.status IN \('DONE'\)/);
  });

  it("respecte les catégories qui ne comptabilisent pas le temps opérateur", () => {
    expect(sql).toMatch(/COALESCE\(c\.counts_operator_time, true\)/);
  });

  it("expose une fonction de recalcul complet, jamais incrémentale", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_production_operation_real_hours/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_production_recompute_operation_real_time/);
    // Le recalcul affecte la valeur, il ne l'additionne pas.
    expect(sql).toMatch(/SET temps_total_real = v_hours/);
    expect(sql).not.toMatch(/temps_total_real\s*=\s*temps_total_real\s*\+/);
  });

  it("conserve l'unité historique du temps réel (heures, 3 décimales)", () => {
    expect(sql).toMatch(/\/ 60\.0,\s*\n?\s*3\s*\n?\s*\)/);
  });
});

describe("#274 patch — intégrité des déclarations de quantités", () => {
  it("rend les déclarations append-only", () => {
    expect(sql).toMatch(/production_quantity_declarations_append_only/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.production_quantity_declarations/);
    expect(sql).toMatch(/is append-only/);
  });

  it("exige une cause pour tout rebut et toute reprise", () => {
    expect(sql).toMatch(/qty_scrap <= 0 OR scrap_reason_code IS NOT NULL/);
    expect(sql).toMatch(/qty_rework <= 0 OR rework_reason_code IS NOT NULL/);
  });

  it("n'autorise les valeurs négatives que sur une compensation motivée", () => {
    expect(sql).toMatch(/compensates_id IS NOT NULL\s*\n?\s*OR \(qty_good >= 0/);
    expect(sql).toMatch(/compensates_id IS NULL OR compensation_reason IS NOT NULL/);
  });

  it("interdit de compenser deux fois la même déclaration", () => {
    expect(sql).toMatch(/production_quantity_declarations_compensates_uniq/);
  });
});

describe("#274 patch — concurrence", () => {
  it("pose des contraintes d'exclusion anti-chevauchement", () => {
    expect(sql).toMatch(/EXCLUDE USING gist/);
    expect(sql).toMatch(/production_pointages_operator_no_overlap/);
    expect(sql).toMatch(/production_pointages_machine_no_overlap/);
  });

  it("utilise la convention d'intervalle [début, fin)", () => {
    // Deux segments bout à bout ne se chevauchent pas.
    expect(sql).toMatch(/tstzrange\(start_ts, COALESCE\(end_ts, 'infinity'::timestamptz\), '\[\)'\)/);
  });

  it("ne fait jamais échouer le patch sur des chevauchements préexistants", () => {
    // Sur une base réelle, un chevauchement historique doit produire un avis,
    // pas une migration bloquée.
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(/reprise humaine requise/);
  });

  it("rend la clé d'idempotence unique", () => {
    expect(sql).toMatch(/production_pointages_idempotency_key_uniq/);
    expect(sql).toMatch(/production_quantity_declarations_idempotency_key_uniq/);
  });

  it("ne stocke qu'une empreinte de charge utile, jamais la charge utile", () => {
    expect(sql).toMatch(/request_fingerprint text NOT NULL/);
    expect(sql).toMatch(/char_length\(request_fingerprint\) = 64/);
  });
});

describe("#274 patch — référentiel d'activités", () => {
  it("sème les quinze catégories de la matrice", () => {
    for (const code of [
      "SETUP",
      "PRODUCTION",
      "PROGRAMMING",
      "CONTROL",
      "MAINTENANCE",
      "CLEANING",
      "TOOL_CHANGE",
      "WAIT_MATERIAL",
      "WAIT_QUALITY",
      "WAIT_PROGRAM",
      "BREAKDOWN",
      "PLANNED_STOP",
      "UNPLANNED_STOP",
      "REWORK",
      "OTHER",
    ]) {
      expect(sql).toContain(`'${code}'`);
    }
  });

  it("conserve la compatibilité avec les DEUX enums historiques", () => {
    expect(sql).toMatch(/legacy_time_type production_pointage_time_type NULL/);
    expect(sql).toMatch(/legacy_of_time_log_type public\.of_time_log_type NULL/);
  });

  it("rend les catégories datées et désactivables plutôt que supprimables", () => {
    expect(sql).toMatch(/effective_from date NOT NULL/);
    expect(sql).toMatch(/disabled_at timestamptz NULL/);
  });
});

describe("#274 patch — fichiers d'accompagnement", () => {
  it("fournit preflight, verify, smoke, recalcul historique et rollback", () => {
    for (const suffix of ["preflight", "verify", "smoke", "recompute-history", "rollback"]) {
      const file = path.join(SUPPORT, `20260726_production_execution_274.${suffix}.sql`);
      expect(fs.existsSync(file), `${suffix} manquant`).toBe(true);
    }
  });

  it("borne le recalcul historique à la base explicitement nommée", () => {
    const recompute = fs.readFileSync(
      path.join(SUPPORT, "20260726_production_execution_274.recompute-history.sql"),
      "utf8"
    );
    expect(recompute).toMatch(/expected_database/);
    expect(recompute).toMatch(/current_database\(\) = :'expected_database'/);
    expect(recompute).toMatch(/SET\s+temps_total_real = preview\.target_hours/);
    expect(recompute).not.toMatch(/\b(DELETE|TRUNCATE|DROP TABLE)\b/i);
  });

  it("le rollback refuse de s'exécuter sur une base de production", () => {
    const rollback = fs.readFileSync(
      path.join(SUPPORT, "20260726_production_execution_274.rollback.sql"),
      "utf8"
    );
    expect(rollback).toMatch(/current_database\(\) NOT IN \('cerp_test'/);
    expect(rollback).toMatch(/rollback refusé/);
  });

  it("le rollback refuse d'effacer des déclarations réelles", () => {
    const rollback = fs.readFileSync(
      path.join(SUPPORT, "20260726_production_execution_274.rollback.sql"),
      "utf8"
    );
    expect(rollback).toMatch(/déclaration\(s\) de quantité existent/);
    expect(rollback).toMatch(/Décision humaine requise/);
  });

  it("le preflight détecte les chevauchements bloquants sans rien modifier", () => {
    const preflight = fs.readFileSync(
      path.join(SUPPORT, "20260726_production_execution_274.preflight.sql"),
      "utf8"
    );
    expect(preflight).toMatch(/chevauchements_operateur/);
    expect(preflight).toMatch(/chevauchements_machine/);
    expect(preflight).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
  });

  it("le verify prouve l'absence de double comptage", () => {
    const verify = fs.readFileSync(
      path.join(SUPPORT, "20260726_production_execution_274.verify.sql"),
      "utf8"
    );
    expect(verify).toMatch(/lignes_legacy_comptees_en_double/);
    expect(verify).toMatch(/fn_production_operation_real_hours/);
    expect(verify).not.toMatch(/AND FALSE/i);
  });
});
