import pool from "../../../config/database";
import { PaymentMode } from "../types/payment-mode.types";

export async function findAllPaymentModes(): Promise<PaymentMode[]> {
  const { rows } = await pool.query(
    `SELECT payment_id AS id, payment_code AS code, type
     FROM mode_reglement
     ORDER BY payment_code ASC`
  );
  return rows;
}

export async function insertPaymentMode(name: string, code?: string): Promise<PaymentMode> {
  // store UI “name” in payment_code; default type = name
  const { rows } = await pool.query(
    `INSERT INTO mode_reglement (payment_code, type)
     VALUES ($1, $2)
     RETURNING payment_id AS id, payment_code AS code, type`,
    [code && code.trim() ? code : name, name]
  );
  return rows[0];
}
