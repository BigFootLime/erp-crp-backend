// src/module/pieces-families/repository/pieces-families.repository.ts
import type { PieceFamily, CreatePieceFamilyInput } from "../types/pieces-families.types"
import db from "../../../config/database"

export async function repoCreatePieceFamily(
  input: CreatePieceFamilyInput
): Promise<PieceFamily> {
  const sql = `
    INSERT INTO pieces_families (code, designation, type_famille, section)
    VALUES ($1, $2, $3, $4)
    RETURNING id, code, designation, type_famille, section, created_at, updated_at
  `
  const params = [input.code, input.designation, input.type_famille ?? null, input.section ?? null]
  const { rows } = await db.query(sql, params)
  return rows[0]
}

export async function repoListPieceFamilies(): Promise<PieceFamily[]> {
  const sql = `
    SELECT id, code, designation, type_famille, section, created_at, updated_at
    FROM pieces_families
    ORDER BY created_at DESC
  `
  const { rows } = await db.query(sql)
  return rows
}

export async function repoGetPieceFamily(id: string): Promise<PieceFamily | null> {
  const sql = `
    SELECT id, code, designation, type_famille, section, created_at, updated_at
    FROM pieces_families
    WHERE id = $1
  `
  const { rows } = await db.query(sql, [id])
  return rows[0] ?? null
}

export async function repoDeletePieceFamily(id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM pieces_families WHERE id = $1`,
    [id]
  )
  return (rowCount ?? 0) > 0
}

export async function repoUpdatePieceFamily(
  id: string,
  patch: Partial<CreatePieceFamilyInput>
): Promise<PieceFamily | null> {
  const fields: string[] = []
  const values: any[] = []
  let i = 1

  if (patch.code !== undefined) { fields.push(`code = $${i++}`); values.push(patch.code) }
  if (patch.designation !== undefined) { fields.push(`designation = $${i++}`); values.push(patch.designation) }
  if (patch.type_famille !== undefined) { fields.push(`type_famille = $${i++}`); values.push(patch.type_famille) }
  if (patch.section !== undefined) { fields.push(`section = $${i++}`); values.push(patch.section) }

  if (!fields.length) return repoGetPieceFamily(id)

  const sql = `
    UPDATE pieces_families
    SET ${fields.join(", ")}, updated_at = now()
    WHERE id = $${i}
    RETURNING id, code, designation, type_famille, section, created_at, updated_at
  `
  values.push(id)

  const { rows } = await db.query(sql, values)
  return rows[0] ?? null
}
