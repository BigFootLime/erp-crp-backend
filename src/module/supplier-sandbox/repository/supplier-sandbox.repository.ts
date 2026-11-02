import pool from "../../../config/database";
import type { SupplierSandboxIdentity } from "../types/supplier-sandbox.types";
export async function repoFindSupplierSandboxAccount(email: string) {
  const r = await pool.query(
    `SELECT id::text,supplier_id::text,email_normalized,password_hash,session_epoch,status FROM supplier_sandbox_accounts WHERE email_normalized=$1`,
    [email],
  );
  return r.rows[0] as
    | undefined
    | {
        id: string;
        supplier_id: string;
        password_hash: string;
        session_epoch: number;
        status: string;
      };
}
export async function repoGetLiveSupplierSandboxAccount(
  i: SupplierSandboxIdentity,
) {
  const r = await pool.query(
    `SELECT id::text FROM supplier_sandbox_accounts WHERE id=$1::uuid AND supplier_id=$2::uuid AND session_epoch=$3 AND status='ACTIVE'`,
    [i.accountId, i.supplierId, i.sessionEpoch],
  );
  return r.rows[0] ?? null;
}
export async function repoListSupplierSandboxLines(i: SupplierSandboxIdentity) {
  const r = await pool.query(
    `SELECT c.id::text order_id,c.code,l.id::text line_id,l.position,l.type,l.designation,l.reference_fournisseur,l.unite,l.quantite::text ordered_quantity,l.qty_annulee::text cancelled_quantity,COALESCE(received.quantity,0)::text received_quantity,GREATEST(l.quantite-l.qty_annulee-COALESCE(received.quantity,0),0)::text remaining_quantity,COALESCE(l.date_besoin,c.date_besoin)::text need_date,COALESCE(l.date_promesse,c.date_promesse)::text promised_date,l.operation_libelle,l.of_id FROM commande_fournisseur c JOIN commande_fournisseur_ligne l ON l.commande_id=c.id LEFT JOIN LATERAL(SELECT COALESCE(SUM(rl.qty_received),0) quantity FROM reception_fournisseur_lignes rl JOIN receptions_fournisseurs rf ON rf.id=rl.reception_id WHERE rl.commande_fournisseur_ligne_id=l.id AND rf.status NOT IN ('ANNULEE','CANCELLED')) received ON true WHERE c.fournisseur_id=$1::uuid AND c.statut IN ('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE') AND l.statut_ligne='ACTIVE' AND l.quantite-l.qty_annulee-COALESCE(received.quantity,0)>0 ORDER BY COALESCE(l.date_besoin,c.date_besoin) NULLS LAST,c.code,l.position`,
    [i.supplierId],
  );
  return r.rows;
}
export async function repoCreateSupplierSandboxProposal(x: {
  identity: SupplierSandboxIdentity;
  orderId: string;
  lineId: string;
  promisedDate: string;
  promisedQuantity: number;
  reason: string;
  idempotencyKey: string;
  requestHash: string;
}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const old = await c.query(
      `SELECT id::text,status,request_hash FROM supplier_sandbox_promise_proposals WHERE account_id=$1::uuid AND idempotency_key=$2`,
      [x.identity.accountId, x.idempotencyKey],
    );
    if (old.rowCount) {
      if (old.rows[0].request_hash !== x.requestHash)
        throw Object.assign(new Error("idempotency payload mismatch"), {
          code: "SUPPLIER_SANDBOX_IDEMPOTENCY_PAYLOAD_MISMATCH",
        });
      await c.query("COMMIT");
      return { ...old.rows[0], replayed: true };
    }
    const owned = await c.query(
      `SELECT l.id FROM commande_fournisseur c JOIN commande_fournisseur_ligne l ON l.commande_id=c.id WHERE c.id=$1::uuid AND l.id=$2::uuid AND c.fournisseur_id=$3::uuid AND c.statut IN ('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE') AND l.statut_ligne='ACTIVE' FOR SHARE`,
      [x.orderId, x.lineId, x.identity.supplierId],
    );
    if (!owned.rowCount)
      throw Object.assign(new Error("missing"), {
        code: "SUPPLIER_LINE_NOT_FOUND",
      });
    const created = await c.query(
      `INSERT INTO supplier_sandbox_promise_proposals(account_id,supplier_id,order_id,line_id,promised_date,promised_quantity,reason,idempotency_key,request_hash) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6,$7,$8,$9) RETURNING id::text,status,submitted_at`,
      [
        x.identity.accountId,
        x.identity.supplierId,
        x.orderId,
        x.lineId,
        x.promisedDate,
        x.promisedQuantity,
        x.reason,
        x.idempotencyKey,
        x.requestHash,
      ],
    );
    await c.query("COMMIT");
    return { ...created.rows[0], replayed: false };
  } catch (e: any) {
    await c.query("ROLLBACK");
    if (e?.code !== "23505") throw e;
    const old = await pool.query<{
      id: string;
      status: string;
      request_hash: string;
    }>(
      `SELECT id::text,status,request_hash FROM supplier_sandbox_promise_proposals WHERE account_id=$1::uuid AND idempotency_key=$2`,
      [x.identity.accountId, x.idempotencyKey],
    );
    if (!old.rowCount) throw e;
    if (old.rows[0].request_hash !== x.requestHash)
      throw Object.assign(new Error("idempotency payload mismatch"), {
        code: "SUPPLIER_SANDBOX_IDEMPOTENCY_PAYLOAD_MISMATCH",
      });
    return { ...old.rows[0], replayed: true };
  } finally {
    c.release();
  }
}
