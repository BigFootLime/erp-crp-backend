import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Garde-fous migrations Project Office (#130) : ADDITIF + IDEMPOTENT, jamais destructif.
const patchDir = path.resolve(__dirname, "../../db/patches");
const core = fs.readFileSync(path.join(patchDir, "20260710_project_office_core.sql"), "utf8");
const report = fs.readFileSync(path.join(patchDir, "20260710_project_office_report.sql"), "utf8");
const files = fs.readFileSync(path.join(patchDir, "20260710_project_office_report_files.sql"), "utf8");
const all = core + "\n" + report + "\n" + files;

describe("Migrations Project Office — additives et idempotentes", () => {
  it("aucun DROP TABLE / DROP COLUMN / TRUNCATE / DELETE", () => {
    expect(all).not.toMatch(/DROP\s+TABLE/i);
    expect(all).not.toMatch(/DROP\s+COLUMN/i);
    expect(all).not.toMatch(/TRUNCATE/i);
    expect(all).not.toMatch(/\bDELETE\s+FROM/i);
    expect(all).not.toMatch(/ALTER\s+COLUMN[^;]*TYPE/i); // pas de changement de type
  });
  it("toutes les tables en CREATE TABLE IF NOT EXISTS (16 cœur + 11 rapport)", () => {
    expect(core.match(/CREATE TABLE IF NOT EXISTS/g)?.length).toBe(16);
    expect(report.match(/CREATE TABLE IF NOT EXISTS/g)?.length).toBe(11);
    expect(all).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });
  it("index et colonnes gardés (IF NOT EXISTS), enums gardés par pg_type", () => {
    expect(all).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
    expect(files).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect((core + report).match(/IF NOT EXISTS \(SELECT 1 FROM pg_type/g)?.length).toBe(25);
  });
  it("feature flag fail-closed : enabled DEFAULT false, jamais de seed enabled=true dans les patches", () => {
    expect(core).toMatch(/enabled boolean NOT NULL DEFAULT false/);
    expect(all).not.toMatch(/INSERT INTO public\.app_feature_flags/i);
  });
  it("FK utilisateurs en integer vers public.users(id) (convention hr)", () => {
    expect(core).toMatch(/owner_id integer NOT NULL/);
    expect(core).toMatch(/REFERENCES public\.users\(id\)/);
  });
  it("rollbacks fournis et hors du répertoire du runner", () => {
    const support = path.join(patchDir, "support");
    for (const f of [
      "20260710_project_office_core.rollback.sql",
      "20260710_project_office_core.verify.sql",
      "20260710_project_office_report.rollback.sql",
      "20260710_project_office_report.verify.sql",
    ]) {
      expect(fs.existsSync(path.join(support, f)), f).toBe(true);
    }
    const reportVerify = fs.readFileSync(path.join(support, "20260710_project_office_report.verify.sql"), "utf8");
    const reportRollback = fs.readFileSync(path.join(support, "20260710_project_office_report.rollback.sql"), "utf8");
    expect(reportVerify).toMatch(/project_report_assets', 'content_base64'/);
    expect(reportVerify).toMatch(/project_report_assets', 'checksum'/);
    expect(reportVerify).toMatch(/project_report_exports', 'file_base64'/);
    expect(reportRollback).toMatch(/20260710_project_office_report_files\.sql/);
  });
  it("seed enable-test protégé contre cerp_prod", () => {
    const seed = fs.readFileSync(path.resolve(__dirname, "../../db/seeds/project-office-flag-enable-test.sql"), "utf8");
    expect(seed).toMatch(/current_database\(\)\s*=\s*'cerp_prod'/);
    expect(seed).toMatch(/RAISE EXCEPTION/);
  });
  it("seed pilote KEENAN cible un user unique sans activer le flag global", () => {
    const seed = fs.readFileSync(path.resolve(__dirname, "../../db/seeds/project-office-pilot-keenan.sql"), "utf8");
    expect(seed).toMatch(/upper\(btrim\(username\)\)\s*=\s*'KEENAN'/i);
    expect(seed).toMatch(/v_user_count\s*<>\s*1/i);
    expect(seed).toMatch(/app_feature_flag_users/i);
    expect(seed).not.toMatch(/UPDATE\s+public\.app_feature_flags\s+SET\s+enabled\s*=\s*true/i);
    expect(seed).toMatch(/project_office_pilot_approved/i);
  });
});
