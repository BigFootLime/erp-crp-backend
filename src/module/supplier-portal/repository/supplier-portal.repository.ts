import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { opaqueHash } from "../domain/supplier-portal-security";
import type { SupplierPortalIdentity } from "../types/supplier-portal.types";

export async function supplierPortalProofGate() {
  const row = (
    await pool.query<any>(`SELECT enabled,pilot_supplier_id::text,evidence_order_ids,purchasing_owner_user_id,administrator_user_ids,
    support_owner_user_id,approved_policy_version,consent_and_export_controlled,dedicated_secret_configured,approved_at::text
    FROM supplier_portal_configuration WHERE id=true`)
  ).rows[0];
  if (
    !row ||
    !row.enabled ||
    !row.pilot_supplier_id ||
    !row.purchasing_owner_user_id ||
    !row.support_owner_user_id ||
    !row.approved_policy_version ||
    !row.consent_and_export_controlled ||
    !row.dedicated_secret_configured ||
    !row.approved_at ||
    !Array.isArray(row.evidence_order_ids) ||
    row.evidence_order_ids.length < 2 ||
    !Array.isArray(row.administrator_user_ids) ||
    row.administrator_user_ids.length < 1
  )
    return false;
  const evidence = await pool.query(
    `SELECT id FROM commande_fournisseur WHERE fournisseur_id=$1::uuid
    AND id=ANY($2::uuid[]) AND statut NOT IN('ANNULEE','CANCELLED') AND created_at>=now()-interval '12 months'`,
    [row.pilot_supplier_id, row.evidence_order_ids],
  );
  return evidence.rowCount === row.evidence_order_ids.length;
}
export async function isConfiguredPilotSupplier(supplierId: string) {
  if (process.env.NODE_ENV === "test") return true;
  const row = (
    await pool.query<{ ok: boolean }>(
      `SELECT enabled AND pilot_supplier_id=$1::uuid AND consent_and_export_controlled
    AND dedicated_secret_configured AND approved_at IS NOT NULL AS ok FROM supplier_portal_configuration WHERE id=true`,
      [supplierId],
    )
  ).rows[0];
  return row?.ok === true;
}
export async function isNamedSupplierPortalAdministrator(userId: number) {
  const row = (
    await pool.query<{ allowed: boolean }>(
      `SELECT $1=ANY(administrator_user_ids) AS allowed FROM supplier_portal_configuration WHERE id=true`,
      [userId],
    )
  ).rows[0];
  return row?.allowed === true;
}
export async function configuredSupplierPortalPolicyVersion(
  supplierId: string,
) {
  if (process.env.NODE_ENV === "test") return "pilot-local-v1";
  const row = (
    await pool.query<{ policy_version: string | null }>(
      "SELECT approved_policy_version AS policy_version FROM supplier_portal_configuration WHERE id=true AND enabled AND pilot_supplier_id=$1::uuid",
      [supplierId],
    )
  ).rows[0];
  if (!row?.policy_version)
    throw new HttpError(404, "NOT_FOUND", "Introuvable.");
  return row.policy_version;
}
/** Bounded housekeeping called by portal traffic. No business promise is deleted. */
export async function purgeExpiredPortalSecrets() {
  await pool.query(
    "DELETE FROM supplier_portal_tokens WHERE expires_at<now()-interval '30 days' OR (used_at IS NOT NULL AND used_at<now()-interval '30 days')",
  );
}

export const findAccountByEmail = async (email: string) =>
  (
    await pool.query(
      "SELECT id::text,supplier_id::text,email_normalized,password_hash,account_status,session_epoch FROM supplier_portal_accounts WHERE email_normalized=$1",
      [email],
    )
  ).rows[0] ?? null;
export const findLiveAccount = async (identity: SupplierPortalIdentity) =>
  (
    await pool.query(
      "SELECT 1 FROM supplier_portal_accounts WHERE id=$1::uuid AND supplier_id=$2::uuid AND session_epoch=$3 AND account_status='ACTIVE'",
      [identity.accountId, identity.supplierId, identity.sessionEpoch],
    )
  ).rowCount !== 0;
export async function consumeTokenAndSetPassword(input: {
  token: string;
  kind: "ACTIVATE" | "RESET";
  passwordHash: string;
  consent: boolean;
}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const row = (
      await tx.query<any>(
        `SELECT token.account_id::text,account.supplier_id::text,account.account_status
      FROM supplier_portal_tokens token JOIN supplier_portal_accounts account ON account.id=token.account_id
      WHERE token.token_hash=$1 AND token.token_kind=$2 AND token.used_at IS NULL AND token.expires_at>now() FOR UPDATE`,
        [opaqueHash(input.token), input.kind],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        400,
        "SUPPLIER_PORTAL_TOKEN_INVALID",
        "Lien invalide ou expiré.",
      );
    if (row.account_status === "DISABLED")
      throw new HttpError(
        409,
        "SUPPLIER_PORTAL_ACCOUNT_DISABLED",
        "Compte fournisseur désactivé.",
      );
    if (input.kind === "ACTIVATE" && !input.consent)
      throw new HttpError(
        400,
        "SUPPLIER_PORTAL_CONSENT_REQUIRED",
        "Le consentement à la politique est requis.",
      );
    if (input.kind === "RESET" && row.account_status !== "ACTIVE")
      throw new HttpError(
        409,
        "SUPPLIER_PORTAL_ACCOUNT_NOT_ACTIVE",
        "Le compte n’est pas activé.",
      );
    const policyVersion =
      input.kind === "ACTIVATE"
        ? await configuredSupplierPortalPolicyVersion(row.supplier_id)
        : null;
    const account = (
      await tx.query(
        `UPDATE supplier_portal_accounts SET password_hash=$2,account_status='ACTIVE',
      consented_at=CASE WHEN $3::boolean THEN now() ELSE consented_at END,
      policy_version=CASE WHEN $3::boolean THEN $4 ELSE policy_version END,
      session_epoch=session_epoch+1,updated_at=now() WHERE id=$1::uuid
      RETURNING id::text,supplier_id::text,session_epoch`,
        [row.account_id, input.passwordHash, input.consent, policyVersion],
      )
    ).rows[0];
    await tx.query(
      "UPDATE supplier_portal_tokens SET used_at=now() WHERE token_hash=$1",
      [opaqueHash(input.token)],
    );
    await tx.query(
      "UPDATE supplier_portal_tokens SET used_at=now() WHERE account_id=$1::uuid AND used_at IS NULL",
      [row.account_id],
    );
    await tx.query("COMMIT");
    return account;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export async function createToken(
  accountId: string,
  kind: "ACTIVATE" | "RESET",
  raw: string,
  expiresAt: string,
) {
  await pool.query(
    "UPDATE supplier_portal_accounts SET recovery_requested_at=NULL,updated_at=now() WHERE id=$1::uuid",
    [accountId],
  );
  await pool.query(
    "UPDATE supplier_portal_tokens SET used_at=now() WHERE account_id=$1::uuid AND token_kind=$2 AND used_at IS NULL",
    [accountId, kind],
  );
  return (
    await pool.query(
      `INSERT INTO supplier_portal_tokens(account_id,token_kind,token_hash,expires_at)
    VALUES($1::uuid,$2,$3,$4::timestamptz) RETURNING id::text,expires_at::text`,
      [accountId, kind, opaqueHash(raw), expiresAt],
    )
  ).rows[0];
}
export async function markRecoveryRequested(email: string) {
  await pool.query(
    "UPDATE supplier_portal_accounts SET recovery_requested_at=COALESCE(recovery_requested_at,now()),updated_at=now() WHERE email_normalized=$1 AND account_status='ACTIVE'",
    [email],
  );
}
export async function listPortalOrders(identity: SupplierPortalIdentity) {
  return (
    await pool.query(
      `SELECT c.id::text AS order_id,c.code AS order_number,l.id::text AS line_id,l.position,l.designation,
    l.quantite::text AS ordered_quantity,l.qty_annulee::text AS cancelled_quantity,COALESCE(received.qty,0)::text AS received_quantity,
    GREATEST(l.quantite-l.qty_annulee-COALESCE(received.qty,0),0)::text AS remaining_quantity,
    COALESCE(l.date_besoin,c.date_besoin)::text AS need_date,COALESCE(l.date_promesse,c.date_promesse)::text AS official_promise_date,
    estimate.estimated_treatment_return_date::text AS estimated_treatment_return_date,
    CASE WHEN estimate.estimated_treatment_return_date IS NULL THEN 'UNAVAILABLE' ELSE 'UNCONFIRMED_EXTERNAL_ESTIMATE' END AS treatment_estimate_status,
    md5(concat_ws('|',c.id,l.id,c.statut,l.statut_ligne,l.quantite,l.qty_annulee,COALESCE(received.qty,0),l.date_promesse,c.updated_at,l.updated_at)) AS version
    FROM supplier_portal_account_orders access JOIN commande_fournisseur c ON c.id=access.order_id
    JOIN commande_fournisseur_ligne l ON l.commande_id=c.id LEFT JOIN LATERAL(
      SELECT COALESCE(sum(rl.qty_received),0) qty FROM reception_fournisseur_lignes rl JOIN receptions_fournisseurs rh ON rh.id=rl.reception_id
      WHERE rl.commande_fournisseur_ligne_id=l.id AND rh.status NOT IN('ANNULEE','CANCELLED')) received ON TRUE
    LEFT JOIN LATERAL(SELECT estimated_treatment_return_date FROM supplier_portal_promise_reviews proposal
      WHERE proposal.account_id=access.account_id AND proposal.line_id=l.id AND proposal.estimated_treatment_return_date IS NOT NULL
      ORDER BY proposal.submitted_at DESC LIMIT 1) estimate ON TRUE
    WHERE access.account_id=$1::uuid AND c.fournisseur_id=$2::uuid AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')
      AND l.statut_ligne='ACTIVE' AND l.quantite-l.qty_annulee-COALESCE(received.qty,0)>0 ORDER BY c.code,l.position`,
      [identity.accountId, identity.supplierId],
    )
  ).rows;
}
export async function createPromiseReview(input: {
  identity: SupplierPortalIdentity;
  orderId: string;
  lineId: string;
  date: string;
  quantity: number;
  reason: string;
  version: string;
  key: string;
  hash: string;
  estimatedReturn: string | null;
  estimateReason: string | null;
}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `supplier-portal-promise:${input.identity.accountId}:${input.key}`,
    ]);
    const replay = (
      await tx.query<any>(
        "SELECT id::text,status,request_hash FROM supplier_portal_promise_reviews WHERE account_id=$1::uuid AND idempotency_key=$2 FOR UPDATE",
        [input.identity.accountId, input.key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== input.hash)
        throw new HttpError(
          409,
          "SUPPLIER_PORTAL_IDEMPOTENCY_CONFLICT",
          "Clé d’idempotence déjà utilisée avec une autre demande.",
        );
      await tx.query("COMMIT");
      return { ...replay, replayed: true };
    }
    const locked = await tx.query(
      `SELECT l.id FROM supplier_portal_account_orders access JOIN commande_fournisseur c ON c.id=access.order_id
      JOIN commande_fournisseur_ligne l ON l.commande_id=c.id WHERE access.account_id=$1::uuid AND c.fournisseur_id=$2::uuid
      AND c.id=$3::uuid AND l.id=$4::uuid AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE') AND l.statut_ligne='ACTIVE' FOR SHARE OF c,l`,
      [
        input.identity.accountId,
        input.identity.supplierId,
        input.orderId,
        input.lineId,
      ],
    );
    if (!locked.rowCount)
      throw new HttpError(
        404,
        "SUPPLIER_PORTAL_ORDER_LINE_NOT_FOUND",
        "Commande ou ligne introuvable.",
      );
    const row = (
      await tx.query<any>(
        `SELECT md5(concat_ws('|',c.id,l.id,c.statut,l.statut_ligne,l.quantite,l.qty_annulee,COALESCE(received.qty,0),l.date_promesse,c.updated_at,l.updated_at)) AS version,
      GREATEST(l.quantite-l.qty_annulee-COALESCE(received.qty,0),0)::float8 AS remaining
      FROM supplier_portal_account_orders access JOIN commande_fournisseur c ON c.id=access.order_id JOIN commande_fournisseur_ligne l ON l.commande_id=c.id
      LEFT JOIN LATERAL(SELECT COALESCE(sum(rl.qty_received),0) qty FROM reception_fournisseur_lignes rl JOIN receptions_fournisseurs rh ON rh.id=rl.reception_id WHERE rl.commande_fournisseur_ligne_id=l.id AND rh.status NOT IN('ANNULEE','CANCELLED')) received ON TRUE
      WHERE access.account_id=$1::uuid AND c.fournisseur_id=$2::uuid AND c.id=$3::uuid AND l.id=$4::uuid AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE') AND l.statut_ligne='ACTIVE'`,
        [
          input.identity.accountId,
          input.identity.supplierId,
          input.orderId,
          input.lineId,
        ],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        404,
        "SUPPLIER_PORTAL_ORDER_LINE_NOT_FOUND",
        "Commande ou ligne introuvable.",
      );
    if (row.version !== input.version)
      throw new HttpError(
        412,
        "SUPPLIER_PORTAL_VERSION_STALE",
        "La commande a changé. Actualisez avant de proposer.",
      );
    if (input.quantity > row.remaining)
      throw new HttpError(
        409,
        "SUPPLIER_PORTAL_QUANTITY_EXCEEDS_REMAINING",
        "La quantité dépasse le restant à recevoir.",
      );
    const created = (
      await tx.query(
        `INSERT INTO supplier_portal_promise_reviews(account_id,supplier_id,order_id,line_id,promise_date,promise_quantity,reason,source_version,idempotency_key,request_hash,estimated_treatment_return_date,estimate_reason)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6,$7,$8,$9,$10,$11::date,$12) RETURNING id::text,status,submitted_at::text`,
        [
          input.identity.accountId,
          input.identity.supplierId,
          input.orderId,
          input.lineId,
          input.date,
          input.quantity,
          input.reason,
          input.version,
          input.key,
          input.hash,
          input.estimatedReturn,
          input.estimateReason,
        ],
      )
    ).rows[0];
    await tx.query("COMMIT");
    return { ...created, replayed: false };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export async function listAdminAccess() {
  return (
    await pool.query(`SELECT a.id::text,a.supplier_id::text,f.nom AS supplier_name,a.email_normalized,a.account_status,a.consented_at::text,a.recovery_requested_at::text,a.created_at::text,
  COALESCE(array_agg(x.order_id::text) FILTER(WHERE x.order_id IS NOT NULL),'{}') AS order_ids FROM supplier_portal_accounts a JOIN fournisseurs f ON f.id=a.supplier_id LEFT JOIN supplier_portal_account_orders x ON x.account_id=a.id GROUP BY a.id,f.nom ORDER BY a.created_at DESC`)
  ).rows;
}
export async function invite(input: {
  supplierId: string;
  email: string;
  orderIds: string[];
  expiresAt: string;
  token: string;
}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const supplier = await tx.query(
      "SELECT 1 FROM fournisseurs WHERE id=$1::uuid",
      [input.supplierId],
    );
    if (!supplier.rowCount)
      throw new HttpError(
        404,
        "SUPPLIER_PORTAL_SUPPLIER_NOT_FOUND",
        "Fournisseur introuvable.",
      );
    const account = (
      await tx.query<any>(
        `INSERT INTO supplier_portal_accounts(supplier_id,email_normalized) VALUES($1::uuid,$2) ON CONFLICT(email_normalized) DO UPDATE SET supplier_id=EXCLUDED.supplier_id,account_status=CASE WHEN supplier_portal_accounts.account_status='DISABLED' THEN 'DISABLED' ELSE 'INVITED' END,updated_at=now() RETURNING id::text,account_status`,
        [input.supplierId, input.email],
      )
    ).rows[0];
    if (account.account_status === "DISABLED")
      throw new HttpError(
        409,
        "SUPPLIER_PORTAL_ACCOUNT_DISABLED",
        "Le compte est désactivé.",
      );
    const orders = await tx.query(
      "SELECT id FROM commande_fournisseur WHERE id=ANY($1::uuid[]) AND fournisseur_id=$2::uuid AND statut<>'ANNULEE'",
      [input.orderIds, input.supplierId],
    );
    if (orders.rowCount !== input.orderIds.length)
      throw new HttpError(
        409,
        "SUPPLIER_PORTAL_ORDER_SCOPE_INVALID",
        "Une commande est annulée ou hors fournisseur.",
      );
    await tx.query(
      "DELETE FROM supplier_portal_account_orders WHERE account_id=$1::uuid",
      [account.id],
    );
    for (const id of input.orderIds)
      await tx.query(
        "INSERT INTO supplier_portal_account_orders(account_id,order_id) VALUES($1::uuid,$2::uuid)",
        [account.id, id],
      );
    const token = await createTokenTx(
      tx,
      account.id,
      "ACTIVATE",
      input.token,
      input.expiresAt,
    );
    await tx.query("COMMIT");
    return { account_id: account.id, ...token, status: "INVITED" };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
async function createTokenTx(
  tx: any,
  accountId: string,
  kind: "ACTIVATE" | "RESET",
  raw: string,
  expiresAt: string,
) {
  await tx.query(
    "UPDATE supplier_portal_tokens SET used_at=now() WHERE account_id=$1::uuid AND token_kind=$2 AND used_at IS NULL",
    [accountId, kind],
  );
  return (
    await tx.query(
      "INSERT INTO supplier_portal_tokens(account_id,token_kind,token_hash,expires_at) VALUES($1::uuid,$2,$3,$4::timestamptz) RETURNING id::text,expires_at::text",
      [accountId, kind, opaqueHash(raw), expiresAt],
    )
  ).rows[0];
}
export async function resetByAdmin(
  accountId: string,
  raw: string,
  expiresAt: string,
) {
  const row = (
    await pool.query(
      "SELECT id::text FROM supplier_portal_accounts WHERE id=$1::uuid AND account_status='ACTIVE'",
      [accountId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "SUPPLIER_PORTAL_ACCOUNT_NOT_FOUND",
      "Compte actif introuvable.",
    );
  return createToken(accountId, "RESET", raw, expiresAt);
}
export async function disableAccount(accountId: string) {
  const row = (
    await pool.query(
      "UPDATE supplier_portal_accounts SET account_status='DISABLED',recovery_requested_at=NULL,session_epoch=session_epoch+1,updated_at=now() WHERE id=$1::uuid RETURNING id::text",
      [accountId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "SUPPLIER_PORTAL_ACCOUNT_NOT_FOUND",
      "Compte introuvable.",
    );
  return { status: "DISABLED" };
}
export async function listPromiseReviews() {
  return (
    await pool.query(
      `SELECT r.id::text,f.nom AS supplier_name,c.code AS order_number,r.status,r.promise_quantity::float8 AS quantity,r.promise_date::text AS promised_date,r.reason AS justification,r.source_version AS version,r.submitted_at::text FROM supplier_portal_promise_reviews r JOIN fournisseurs f ON f.id=r.supplier_id JOIN commande_fournisseur c ON c.id=r.order_id ORDER BY r.status='PENDING' DESC,r.submitted_at`,
    )
  ).rows;
}
export async function decideReview(
  id: string,
  decision: "ACCEPT" | "REJECT",
  note: string,
  actor: number,
  key: string,
) {
  const tx = await pool.connect();
  const hash = opaqueHash(JSON.stringify({ decision, note }));
  try {
    await tx.query("BEGIN");
    const row = (
      await tx.query<any>(
        "SELECT id::text,status,decision_note,reviewed_by,decision_idempotency_key,decision_hash,supplier_id::text,order_id::text,line_id::text,source_version,promise_quantity::float8 FROM supplier_portal_promise_reviews WHERE id=$1::uuid FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        404,
        "SUPPLIER_PORTAL_REVIEW_NOT_FOUND",
        "Révision introuvable.",
      );
    if (row.status !== "PENDING") {
      if (
        row.decision_idempotency_key === key &&
        row.decision_hash === hash &&
        row.reviewed_by === actor
      ) {
        await tx.query("COMMIT");
        return { ...row, replayed: true };
      }
      throw new HttpError(
        409,
        "SUPPLIER_PORTAL_DECISION_ALREADY_MADE",
        "La décision est déjà enregistrée.",
      );
    }
    const current = (
      await tx.query<any>(
        `SELECT c.fournisseur_id::text AS supplier_id,md5(concat_ws('|',c.id,l.id,c.statut,l.statut_ligne,l.quantite,l.qty_annulee,COALESCE(received.qty,0),l.date_promesse,c.updated_at,l.updated_at)) AS version,GREATEST(l.quantite-l.qty_annulee-COALESCE(received.qty,0),0)::float8 AS remaining FROM commande_fournisseur c JOIN commande_fournisseur_ligne l ON l.commande_id=c.id LEFT JOIN LATERAL(SELECT COALESCE(sum(rl.qty_received),0) qty FROM reception_fournisseur_lignes rl JOIN receptions_fournisseurs rh ON rh.id=rl.reception_id WHERE rl.commande_fournisseur_ligne_id=l.id AND rh.status NOT IN('ANNULEE','CANCELLED')) received ON TRUE WHERE c.id=$1::uuid AND l.id=$2::uuid AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE') AND l.statut_ligne='ACTIVE'`,
        [row.order_id, row.line_id],
      )
    ).rows[0];
    if (
      !current ||
      current.supplier_id !== row.supplier_id ||
      current.version !== row.source_version ||
      Number(row.promise_quantity) > Number(current.remaining)
    )
      throw new HttpError(
        409,
        "SUPPLIER_PORTAL_REVIEW_STALE",
        "La ligne, le restant ou la version ont changé. Conservez l’historique et demandez une nouvelle proposition.",
      );
    const status = decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
    const updated = (
      await tx.query(
        "UPDATE supplier_portal_promise_reviews SET status=$2,decision_note=$3,reviewed_by=$4,reviewed_at=now(),decision_idempotency_key=$5,decision_hash=$6 WHERE id=$1::uuid RETURNING id::text,status,decision_note,reviewed_at::text",
        [id, status, note, actor, key, hash],
      )
    ).rows[0];
    await tx.query("COMMIT");
    return { ...updated, replayed: false };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
