import type { PoolClient } from "pg";
import crypto from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type {
  ApprovalEvidence,
  ApprovalPolicy,
  ApprovalRevisionInput,
} from "../domain/client-supplier-approval";

type Queryer = Pick<PoolClient, "query">;
export const APPROVAL_EVIDENCE_SQL = `SELECT d.id::text AS document_id,v.id::text AS version_id,d.code,d.title,
  v.version_number,v.original_name AS filename,b.sha256,b.size_bytes::int
  FROM public.ged_document_versions v JOIN public.ged_documents d ON d.id=v.document_id
  JOIN public.ged_blobs b ON b.id=v.blob_id
  WHERE v.id=$1::uuid AND d.class_key='CERP_AGREMENT_FOURNISSEUR' AND d.archived_at IS NULL
    AND v.status='APPLICABLE' AND b.mime_type='application/pdf'
    AND EXISTS(SELECT 1 FROM public.ged_upload_sessions s WHERE s.id=v.upload_session_id AND s.scan_status='clean' AND s.quarantine_status='released')
    AND (SELECT count(*) FROM public.ged_document_links l WHERE l.document_id=d.id)=1
    AND EXISTS(SELECT 1 FROM public.ged_document_links l WHERE l.document_id=d.id AND l.entity_type='CLIENT' AND l.entity_id=$2)
`;
export const APPROVAL_POLICIES_SQL = `SELECT s.id::text AS scope_id,s.client_id,s.product_article_id::text,s.purchase_article_id::text,s.domaine_code,
  r.id::text AS revision_id,r.revision,r.required,r.suspended,r.exclusive,r.valid_from::text,r.valid_to::text,
  ARRAY(SELECT m.supplier_id::text FROM public.client_supplier_approval_members m WHERE m.revision_id=r.id ORDER BY m.supplier_id) AS supplier_ids,
  r.evidence_snapshot AS evidence,r.reason,r.created_at::text,
  (d.archived_at IS NULL AND v.status='APPLICABLE' AND b.sha256=r.evidence_snapshot->>'sha256'
   AND b.mime_type='application/pdf' AND EXISTS(SELECT 1 FROM public.ged_upload_sessions u WHERE u.id=v.upload_session_id AND u.scan_status='clean' AND u.quarantine_status='released')
   AND (SELECT count(*) FROM public.ged_document_links l WHERE l.document_id=d.id)=1
   AND EXISTS(SELECT 1 FROM public.ged_document_links l WHERE l.document_id=d.id AND l.entity_type='CLIENT' AND l.entity_id=s.client_id)) AS evidence_applicable
  FROM public.client_supplier_approval_scopes s
  JOIN LATERAL (SELECT * FROM public.client_supplier_approval_revisions x WHERE x.scope_id=s.id ORDER BY x.revision DESC LIMIT 1) r ON true
  JOIN public.ged_documents d ON d.id=r.document_id JOIN public.ged_document_versions v ON v.id=r.version_id AND v.document_id=d.id
  JOIN public.ged_blobs b ON b.id=v.blob_id
  WHERE s.client_id=ANY($1::text[]) ORDER BY s.client_id,s.domaine_code,s.id`;

export async function readApprovalPoliciesTx(
  tx: Queryer,
  clientIds: string[],
  lock = false,
): Promise<ApprovalPolicy[]> {
  if (!clientIds.length) return [];
  return (
    await tx.query<ApprovalPolicy>(
      APPROVAL_POLICIES_SQL + (lock ? " FOR SHARE OF d,v,b" : ""),
      [clientIds],
    )
  ).rows;
}
export async function repoApprovalPolicies(
  clientId: string,
): Promise<ApprovalPolicy[]> {
  return readApprovalPoliciesTx(pool, [clientId]);
}
export async function readApprovalEvidenceTx(
  tx: Queryer,
  versionId: string,
  clientId: string,
  lock = false,
): Promise<ApprovalEvidence | null> {
  return (
    (
      await tx.query<ApprovalEvidence>(
        APPROVAL_EVIDENCE_SQL + (lock ? " FOR SHARE OF d,v,b" : ""),
        [versionId, clientId],
      )
    ).rows[0] ?? null
  );
}
export async function repoApprovalEvidenceChoices(
  clientId: string,
): Promise<ApprovalEvidence[]> {
  const ids = (
    await pool.query<{ id: string }>(
      `SELECT v.id::text FROM public.ged_documents d JOIN public.ged_document_versions v ON v.document_id=d.id
    JOIN public.ged_document_links l ON l.document_id=d.id AND l.entity_type='CLIENT' AND l.entity_id=$1
    WHERE d.class_key='CERP_AGREMENT_FOURNISSEUR' AND d.archived_at IS NULL AND v.status='APPLICABLE' ORDER BY d.code,v.version_number DESC LIMIT 100`,
      [clientId],
    )
  ).rows;
  const choices: ApprovalEvidence[] = [];
  for (const row of ids) {
    const evidence = await readApprovalEvidenceTx(pool, row.id, clientId);
    if (evidence) choices.push(evidence);
  }
  return choices;
}

/** Parent locks serialize policy creation and purchase engagement, including empty scopes. */
export async function repoAppendApprovalRevision(
  input: ApprovalRevisionInput,
  actor: number,
): Promise<{ scope_id: string; revision_id: string }> {
  const requestHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        actor,
        input: { ...input, supplier_ids: [...input.supplier_ids].sort() },
      }),
    )
    .digest("hex");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `client-approval:${input.idempotency_key}`,
    ]);
    const replay = (
      await tx.query<{
        scope_id: string;
        revision_id: string;
        request_hash: string;
      }>(
        `SELECT scope_id::text,id::text AS revision_id,request_hash FROM public.client_supplier_approval_revisions WHERE idempotency_key=$1::uuid`,
        [input.idempotency_key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== requestHash)
        throw new HttpError(
          409,
          "CLIENT_APPROVAL_IDEMPOTENCY_CONFLICT",
          "Cette demande a déjà été utilisée avec un autre agrément.",
        );
      await tx.query("COMMIT");
      return { scope_id: replay.scope_id, revision_id: replay.revision_id };
    }
    if (
      !(
        await tx.query(
          "SELECT client_id FROM public.clients WHERE client_id=$1 FOR UPDATE",
          [input.scope.client_id],
        )
      ).rows.length
    )
      throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
    const suppliers = (
      await tx.query(
        "SELECT id FROM public.fournisseurs WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE",
        [input.supplier_ids],
      )
    ).rows;
    if (suppliers.length !== input.supplier_ids.length)
      throw new HttpError(
        422,
        "CLIENT_APPROVAL_SUPPLIER_INVALID",
        "Un fournisseur sélectionné est introuvable.",
      );
    const scope = (
      await tx.query<{ id: string }>(
        `SELECT id::text FROM public.client_supplier_approval_scopes WHERE client_id=$1
      AND product_article_id IS NOT DISTINCT FROM $2::uuid AND purchase_article_id IS NOT DISTINCT FROM $3::uuid AND domaine_code=$4`,
        [
          input.scope.client_id,
          input.scope.product_article_id,
          input.scope.purchase_article_id,
          input.scope.domaine_code,
        ],
      )
    ).rows[0];
    const scopeId = scope?.id ?? crypto.randomUUID();
    const current = scope
      ? (
          await tx.query<{ id: string; revision: number }>(
            `SELECT id::text,revision FROM public.client_supplier_approval_revisions WHERE scope_id=$1::uuid ORDER BY revision DESC LIMIT 1`,
            [scopeId],
          )
        ).rows[0]
      : null;
    if ((current?.id ?? null) !== input.expected_revision_id)
      throw new HttpError(
        409,
        "CLIENT_APPROVAL_REVISION_CONFLICT",
        "L’agrément a changé. Actualisez avant d’enregistrer.",
      );
    const evidence = await readApprovalEvidenceTx(
      tx,
      input.evidence_version_id,
      input.scope.client_id,
      true,
    );
    if (!evidence)
      throw new HttpError(
        422,
        "CLIENT_APPROVAL_EVIDENCE_REQUIRED",
        "Sélectionnez un justificatif PDF approuvé et contrôlé, rattaché à ce client dans la GED.",
      );
    if (!scope)
      await tx.query(
        `INSERT INTO public.client_supplier_approval_scopes(id,client_id,product_article_id,purchase_article_id,domaine_code,created_by)
      VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,$6)`,
        [
          scopeId,
          input.scope.client_id,
          input.scope.product_article_id,
          input.scope.purchase_article_id,
          input.scope.domaine_code,
          actor,
        ],
      );
    const revisionId = crypto.randomUUID();
    await tx.query(
      `INSERT INTO public.client_supplier_approval_revisions(id,scope_id,revision,required,suspended,exclusive,valid_from,valid_to,document_id,version_id,evidence_snapshot,reason,created_by,idempotency_key,request_hash)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7::date,$8::date,$9::uuid,$10::uuid,$11::jsonb,$12,$13,$14::uuid,$15)`,
      [
        revisionId,
        scopeId,
        (current?.revision ?? 0) + 1,
        input.required,
        input.suspended,
        input.exclusive,
        input.valid_from,
        input.valid_to,
        evidence.document_id,
        evidence.version_id,
        JSON.stringify(evidence),
        input.reason,
        actor,
        input.idempotency_key,
        requestHash,
      ],
    );
    await tx.query(
      `INSERT INTO public.client_supplier_approval_members(revision_id,supplier_id) SELECT $1::uuid,unnest($2::uuid[])`,
      [revisionId, input.supplier_ids],
    );
    await tx.query(
      `INSERT INTO public.ged_retention_holds(document_id,hold_type,reason,placed_by) VALUES($1::uuid,'LEGAL',$2,$3)`,
      [evidence.document_id, `Client supplier approval ${revisionId}`, actor],
    );
    await repoInsertAuditLog({
      tx,
      user_id: actor,
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      body: {
        event_type: "ACTION",
        action: "CLIENT_SUPPLIER_APPROVAL_REVISED",
        entity_type: "CLIENT",
        entity_id: input.scope.client_id,
        details: {
          scope_id: scopeId,
          revision_id: revisionId,
          scope: input.scope,
          required: input.required,
          suspended: input.suspended,
          exclusive: input.exclusive,
          supplier_ids: input.supplier_ids,
          evidence,
          reason: input.reason,
        },
      },
    });
    await tx.query("COMMIT");
    return { scope_id: scopeId, revision_id: revisionId };
  } catch (error) {
    await tx.query("ROLLBACK");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["23503", "23505"].includes(String(error.code))
    )
      throw new HttpError(
        409,
        "CLIENT_APPROVAL_REFERENCE_CONFLICT",
        "Un périmètre ou une référence a changé. Actualisez les choix avant d’enregistrer.",
      );
    throw error;
  } finally {
    tx.release();
  }
}

export async function repoApprovalHistory(scopeId: string) {
  return (
    await pool.query(
      `SELECT s.client_id,r.id::text AS revision_id,r.revision,r.required,r.suspended,r.exclusive,r.valid_from::text,r.valid_to::text,r.evidence_snapshot AS evidence,r.reason,r.created_at::text,
    ARRAY(SELECT m.supplier_id::text FROM public.client_supplier_approval_members m WHERE m.revision_id=r.id ORDER BY m.supplier_id) AS supplier_ids
    FROM public.client_supplier_approval_scopes s JOIN public.client_supplier_approval_revisions r ON r.scope_id=s.id WHERE s.id=$1::uuid ORDER BY r.revision DESC`,
      [scopeId],
    )
  ).rows;
}
