// src/module/pieces-families/repository/pieces-families.repository.ts
import type { PieceCF, CreatePieceCFInput } from "../types/centre-frais.types"
import db from "../../../config/database"

export async function repoCreatePieceCF(
  input: CreatePieceCFInput
): Promise<PieceCF> {
  const sql = `
    INSERT INTO centres_frais (code, designation, type_cf, section)
    VALUES ($1, $2, $3, $4)
    RETURNING id, code, designation, type_cf, section, created_at, updated_at
  `
  const params = [input.code, input.designation, input.type_cf ?? null, input.section ?? null]
  const { rows } = await db.query(sql, params)
  return rows[0]
}

export async function repoListPieceCF(): Promise<PieceCF[]> {
  const sql = `
    SELECT id, code, designation, type_cf, section, created_at, updated_at
    FROM centres_frais
    ORDER BY created_at DESC
  `
  const { rows } = await db.query(sql)
  return rows
}

export async function repoGetPieceCF(id: string): Promise<PieceCF | null> {
  const sql = `
    SELECT id, code, designation, type_cf, section, created_at, updated_at
    FROM centres_frais
    WHERE id = $1
  `
  const { rows } = await db.query(sql, [id])
  return rows[0] ?? null
}

export async function repoDeletePieceCF(id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM centres_frais WHERE id = $1`,
    [id]
  )
  return (rowCount ?? 0) > 0
}

export async function repoUpdatePieceCF(
  id: string,
  patch: Partial<CreatePieceCFInput>
): Promise<PieceCF | null> {
  const fields: string[] = []
  const values: any[] = []
  let i = 1

  if (patch.code !== undefined) { fields.push(`code = $${i++}`); values.push(patch.code) }
  if (patch.designation !== undefined) { fields.push(`designation = $${i++}`); values.push(patch.designation) }
  if (patch.type_cf !== undefined) { fields.push(`type_cf = $${i++}`); values.push(patch.type_cf) }
  if (patch.section !== undefined) { fields.push(`section = $${i++}`); values.push(patch.section) }

  if (!fields.length) return repoGetPieceCF(id)

  const sql = `
    UPDATE centres_frais
    SET ${fields.join(", ")}, updated_at = now()
    WHERE id = $${i}
    RETURNING id, code, designation, type_cf, section, created_at, updated_at
  `
  values.push(id)

  const { rows } = await db.query(sql, values)
  return rows[0] ?? null
}
