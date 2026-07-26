// #159 — Garde-fous du patch SQL du poste opérateur tablette.
//
// Ces tests lisent le fichier de patch et refusent qu'il devienne destructif au
// fil des relectures. Ils ne remplacent pas le preflight/verify exécutés sur la
// base : ils empêchent la régression AVANT qu'elle n'atteigne une base.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PATCH_DIR = path.resolve(__dirname, "../../db/patches");
const PATCH = path.join(PATCH_DIR, "20260726_shopfloor_station_159.sql");
const SUPPORT = path.join(PATCH_DIR, "support");
const PREFLIGHT = path.join(SUPPORT, "20260726_shopfloor_station_159.preflight.sql");
const VERIFY = path.join(SUPPORT, "20260726_shopfloor_station_159.verify.sql");
const ROLLBACK = path.join(SUPPORT, "20260726_shopfloor_station_159.rollback.sql");

const sql = fs.readFileSync(PATCH, "utf8");

/** Retire les commentaires pour ne juger que le SQL réellement exécuté. */
function executable(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const code = executable(sql);

describe("#159 — le patch est additif et non destructif", () => {
  it("ne supprime aucune table, colonne, contrainte ni type existants", () => {
    // Les DROP tolérés portent UNIQUEMENT sur des triggers recréés dans la
    // foulée : c'est le seul moyen d'être rejouable sur PostgreSQL.
    const drops = code.match(/DROP\s+(TABLE|COLUMN|TYPE|CONSTRAINT|SCHEMA|DATABASE|INDEX|VIEW)/gi) ?? [];
    expect(drops).toEqual([]);
  });

  it("ne réécrit aucune donnée existante", () => {
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    // Les seuls UPDATE autorisés seraient sur les tables créées ici ; il n'y en
    // a aucun, le patch est purement structurel.
    expect(code).not.toMatch(/\bUPDATE\s+public\./i);
  });

  it("est transactionnel", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\bROLLBACK\b/i);
  });

  it("est rejouable : chaque objet est créé de façon idempotente", () => {
    const creates = code.match(/CREATE (TABLE|INDEX|UNIQUE INDEX|SEQUENCE)[^;]*?(?=\()/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const statement of creates) {
      expect(statement).toMatch(/IF NOT EXISTS/i);
    }
    // Fonctions et vues : CREATE OR REPLACE.
    for (const statement of code.match(/CREATE (FUNCTION|VIEW)/gi) ?? []) {
      expect(statement).toBe("");
    }
  });

  it("vérifie ses pré-requis avant d'écrire", () => {
    for (const table of [
      "public.machines",
      "public.users",
      "public.ordres_fabrication",
      "public.of_operations",
      "public.production_pointages",
    ]) {
      expect(code).toContain(`to_regclass('${table}')`);
    }
  });
});

describe("#159 — le patch respecte les frontières inter-modules", () => {
  it("ne touche à AUCUNE table du module RH #119", () => {
    for (const table of ["hr_time_events", "hr_time_clock_devices", "hr_badge_credentials", "hr_"]) {
      expect(code).not.toMatch(new RegExp(`(ALTER|INSERT INTO|UPDATE|DROP)[^;]*${table}`, "i"));
    }
  });

  it("ne touche à AUCUNE table du moteur d'exécution #274", () => {
    for (const table of [
      "production_pointages",
      "production_pointage_events",
      "production_quantity_declarations",
      "of_time_logs",
    ]) {
      expect(code).not.toMatch(new RegExp(`ALTER TABLE[^;]*${table}`, "i"));
      expect(code).not.toMatch(new RegExp(`INSERT INTO public\\.${table}`, "i"));
    }
  });

  it("ne touche à AUCUNE table de stock, livraison ou facturation", () => {
    for (const table of [
      "stock_movements",
      "stock_reservations",
      "lots",
      "bons_livraison",
      "factures",
      "production_receipts",
    ]) {
      expect(code).not.toMatch(new RegExp(`(ALTER TABLE|INSERT INTO|UPDATE) public\\.${table}`, "i"));
    }
  });

  it("ne crée aucune table de temps ni de quantité concurrente", () => {
    const created = [...code.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/gi)].map((m) => m[1]);
    expect(created).toContain("production_devices");
    expect(created).toContain("operator_device_sessions");
    expect(created).toContain("station_audit_events");
    for (const name of created) {
      expect(name).not.toMatch(/time_log|pointage|quantity|duration/i);
    }
  });
});

describe("#159 — le patch protège ce qui doit l'être", () => {
  it("rend le journal d'audit append-only par trigger", () => {
    expect(code).toMatch(/CREATE TRIGGER trg_station_audit_append_only_159/i);
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON public\.station_audit_events/i);
  });

  it("rend la transmission de poste immuable hors accusé de lecture", () => {
    expect(code).toMatch(/CREATE TRIGGER trg_shift_handover_immutable_159/i);
    expect(code).toMatch(/only the acknowledgement can change/i);
  });

  it("laisse le journal d'audit propriété de postgres, pas du rôle applicatif", () => {
    const ownerBlock = code.slice(code.indexOf("ALTER TABLE %s OWNER TO cerp_app") - 800);
    expect(ownerBlock).not.toMatch(/'public\.station_audit_events'/);
    expect(code).toMatch(/GRANT SELECT, INSERT ON public\.station_audit_events TO cerp_app/i);
  });

  it("interdit une tablette fixe sans machine, au niveau de la base", () => {
    expect(code).toMatch(/production_devices_fixed_machine_159_ck/);
    expect(code).toMatch(/assignment_mode <> 'FIXED' OR machine_id IS NOT NULL/);
  });

  it("garantit une seule session vivante par tablette", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS operator_device_sessions_one_live_159_uq/i);
    expect(code).toMatch(/WHERE state IN \('ACTIVE', 'LOCKED'\)/i);
  });

  it("n'accepte que des empreintes, jamais des secrets en clair", () => {
    expect(code).toMatch(/credential_hash text NOT NULL/);
    expect(code).toMatch(/operator_badge_credentials_hash_159_ck[\s\S]*\^\[a-f0-9\]\{64\}\$/);
    expect(code).toMatch(/session_token_hash text NOT NULL/);
    expect(code).not.toMatch(/badge_uid\s+text/i);
    expect(code).not.toMatch(/pin\s+text/i);
  });

  it("borne le verrouillage automatique et la durée de session côté base", () => {
    expect(code).toMatch(/auto_lock_seconds BETWEEN 30 AND 3600/);
    expect(code).toMatch(/session_max_seconds BETWEEN 300 AND 86400/);
  });

  it("génère le code public côté base", () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_production_device_next_public_code/i);
    expect(code).toMatch(/nextval\('public\.production_device_public_code_seq'\)/);
  });
});

describe("#159 — les fichiers de support existent et se comportent bien", () => {
  it("fournit preflight, verify et rollback", () => {
    for (const file of [PREFLIGHT, VERIFY, ROLLBACK]) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it("le preflight n'écrit rien", () => {
    const preflight = executable(fs.readFileSync(PREFLIGHT, "utf8"));
    expect(preflight).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE TABLE|DROP)\b/i);
  });

  it("le verify annule tout ce qu'il écrit", () => {
    const verify = fs.readFileSync(VERIFY, "utf8");
    expect(verify).toMatch(/\bBEGIN;/);
    expect(verify).toMatch(/\bROLLBACK;/);
    expect(verify).not.toMatch(/\bCOMMIT;/);
  });

  it("le rollback refuse cerp_prod et refuse d'effacer des données réelles", () => {
    const rollback = fs.readFileSync(ROLLBACK, "utf8");
    expect(rollback).toMatch(/current_database\(\) = 'cerp_prod'/);
    expect(rollback).toMatch(/donnees reelles presentes/i);
  });
});
