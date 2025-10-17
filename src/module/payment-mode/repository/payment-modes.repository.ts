// src/module/payment-modes/repository/payment-modes.repository.ts
import pool from "../../../config/database";

export type PaymentModeRow = {
  payment_id: string;
  payment_code: string;
  type: string;        // ← intitulé
  notes: string | null;
  creation_date: Date;
  created_by: string | null;
  modification_date: Date | null;
  modified_by: string | null;
};

export async function repoCreatePaymentMode(input: {
  name: string;
  code?: string;
  notes?: string;
  createdBy?: string | null; // username, user_id, email… selon ton auth
}) {
  const code = (input.code ?? input.name)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");    // EX: "Virement 30j" → "VIREMENT_30J"

  const type = input.name.trim(); // intitulé
  const notes = input.notes?.trim() || null;
  const createdBy = input.createdBy ?? null;

  const { rows } = await pool.query<PaymentModeRow>(
    `
    INSERT INTO mode_reglement (payment_code, type, notes, created_by)
    VALUES ($1, $2, $3, $4)
    RETURNING payment_id, payment_code, type, notes, creation_date, created_by, modification_date, modified_by
    `,
    [code, type, notes, createdBy]
  );

  return rows[0];
}

export async function repoListPaymentModes(q = "") {
  const like = `%${q.toLowerCase()}%`;
  const { rows } = await pool.query<PaymentModeRow>(
    `
    SELECT payment_id, payment_code, type, notes, creation_date, created_by, modification_date, modified_by
    FROM mode_reglement
    WHERE $1 = '%%'
       OR LOWER(payment_code) LIKE $1
       OR LOWER(type) LIKE $1
       OR LOWER(COALESCE(notes, '')) LIKE $1
    ORDER BY type ASC
    `,
    [like]
  );
  return rows;
}
