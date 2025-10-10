// src/module/payment-modes/repository/payment-modes.repository.ts
import pool from "../../../config/database";

export type PaymentModeRow = {
  payment_id: string;
  payment_code: string;
  type: string;
};

export async function repoCreatePaymentMode(input: { name: string; code?: string }) {
  const code = (input.code ?? input.name).trim().toUpperCase().replace(/\s+/g, "_");
  const type = input.name.trim();
  const { rows } = await pool.query<PaymentModeRow>(
    `INSERT INTO mode_reglement (payment_code, type)
     VALUES ($1, $2)
     RETURNING payment_id, payment_code, type`,
    [code, type]
  );
  return rows[0];
}

export async function repoListPaymentModes(q = "") {
  const like = `%${q.toLowerCase()}%`;
  const { rows } = await pool.query<PaymentModeRow>(
    `SELECT payment_id, payment_code, type
     FROM mode_reglement
     WHERE $1 = '%%' OR LOWER(payment_code) LIKE $1 OR LOWER(type) LIKE $1
     ORDER BY type ASC`,
    [like]
  );
  return rows;
}
