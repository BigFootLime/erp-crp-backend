// src/module/banking-info/repository/banking-info.repository.ts
import type { BankingInfo, CreateBankingInfoInput } from "../types/banking-info.types"
import db from "../../../config/database" // adjust if your export is named differently

export async function repoCreateBankingInfo(input: CreateBankingInfoInput): Promise<BankingInfo> {
  const sql = `
    INSERT INTO public.informations_bancaires (name, iban, bic, creation_date)
    VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP))
    RETURNING bank_info_id, name, iban, bic, creation_date, created_by, modification_date, modified_by
  `
  const params = [input.name, input.iban, input.bic, input.creation_date ?? null]
  const { rows } = await db.query(sql, params)
  return rows[0]
}

export async function repoListBankingInfos(): Promise<BankingInfo[]> {
  const sql = `
    SELECT bank_info_id, name, iban, bic, creation_date, created_by, modification_date, modified_by
    FROM public.informations_bancaires
    ORDER BY creation_date DESC, bank_info_id DESC
  `
  const { rows } = await db.query(sql)
  return rows
}

export async function repoGetBankingInfo(id: string): Promise<BankingInfo | null> {
  const sql = `
    SELECT bank_info_id, name, iban, bic, creation_date, created_by, modification_date, modified_by
    FROM public.informations_bancaires
    WHERE bank_info_id = $1
  `
  const { rows } = await db.query(sql, [id])
  return rows[0] ?? null
}

export async function repoDeleteBankingInfo(id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM public.informations_bancaires WHERE bank_info_id = $1`, [id])
  return (rowCount ?? 0) > 0  
}

export async function repoUpdateBankingInfo(
  id: string,
  patch: Partial<CreateBankingInfoInput>
): Promise<BankingInfo | null> {
  const fields: string[] = []
  const values: any[] = []
  let i = 1

  if (patch.name !== undefined) { fields.push(`name = $${i++}`); values.push(patch.name) }
  if (patch.iban !== undefined) { fields.push(`iban = $${i++}`); values.push(patch.iban) }
  if (patch.bic !== undefined) { fields.push(`bic = $${i++}`); values.push(patch.bic) }
  if (patch.creation_date !== undefined) { fields.push(`creation_date = $${i++}`); values.push(patch.creation_date) }

  if (!fields.length) return await repoGetBankingInfo(id)

  const sql = `
    UPDATE public.informations_bancaires
    SET ${fields.join(", ")}, modification_date = CURRENT_TIMESTAMP
    WHERE bank_info_id = $${i}
    RETURNING bank_info_id, name, iban, bic, creation_date, created_by, modification_date, modified_by
  `
  values.push(id)
  const { rows } = await db.query(sql, values)
  return rows[0] ?? null
}
