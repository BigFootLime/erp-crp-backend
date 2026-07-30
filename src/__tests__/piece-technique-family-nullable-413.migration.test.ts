import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const PATCH_DIR = path.resolve(__dirname, "../../db/patches")
const SUPPORT_DIR = path.join(PATCH_DIR, "support")
const PATCH = path.join(PATCH_DIR, "20260730_piece_technique_family_nullable_413.sql")
const PREFLIGHT = path.join(SUPPORT_DIR, "20260730_piece_technique_family_nullable_413.preflight.sql")
const VERIFY = path.join(SUPPORT_DIR, "20260730_piece_technique_family_nullable_413.verify.sql")
const ROLLBACK = path.join(SUPPORT_DIR, "20260730_piece_technique_family_nullable_413.rollback.sql")

function executable(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("#413 — famille PT nullable", () => {
  it("ne modifie aucune donnée historique et retire uniquement NOT NULL", () => {
    const sql = executable(fs.readFileSync(PATCH, "utf8"))
    expect(sql).toMatch(/ALTER TABLE public\.pieces_techniques[\s\S]*ALTER COLUMN famille_id DROP NOT NULL/i)
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true)
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true)
  })

  it("fournit les contrôles preflight, verify et rollback", () => {
    for (const file of [PREFLIGHT, VERIFY, ROLLBACK]) {
      expect(fs.existsSync(file)).toBe(true)
    }
    expect(executable(fs.readFileSync(PREFLIGHT, "utf8"))).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i
    )
    expect(fs.readFileSync(PREFLIGHT, "utf8")).toMatch(/to_regclass\('public\.pieces_techniques'\)/i)
    expect(executable(fs.readFileSync(VERIFY, "utf8"))).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i
    )
  })

  it("refuse un rollback dès qu'une PT sans famille existe", () => {
    const rollback = fs.readFileSync(ROLLBACK, "utf8")
    expect(rollback).toMatch(/WHERE famille_id IS NULL/i)
    expect(rollback).toMatch(/RAISE EXCEPTION/i)
    expect(rollback).toMatch(/ALTER COLUMN famille_id SET NOT NULL/i)
  })
  it("preserves historical families and neutralizes new PT flows", () => {
    const repository = fs.readFileSync(
      path.resolve(__dirname, "../module/pieces-techniques/repository/pieces-techniques.repository.ts"),
      "utf8"
    )
    const promotion = fs.readFileSync(
      path.resolve(__dirname, "../module/commande-client/repository/commande-client.repository.ts"),
      "utf8"
    )

    expect(repository).not.toMatch(/if \(patch\.famille_id !== undefined\) sets\.push\("famille_id = NULL"\)/)
    expect(repository).toMatch(/A duplicate is a new PT:[\s\S]*?null,/)
    expect(promotion).not.toMatch(/maybeFamilleId/)
    expect(promotion).toMatch(/famille_id,[\s\S]*?NULL,/)
  })
})
