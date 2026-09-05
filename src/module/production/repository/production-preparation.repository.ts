import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { enqueueProductionOfChanged } from "./production-realtime.repository";
import type { AuditContext } from "./production.repository";
import {
  evaluatePreparation,
  isPreparationReady,
  PREPARATION_RULES_VERSION,
  sourceHash,
  type PreparationDecisions,
  type PreparationFacts,
  type PurchaseEvidence,
} from "../domain/preparation-rules";

type Db = Pick<PoolClient, "query">;
export async function usesPreparationRules(tx: Db, id?: number) {
  const result = await tx.query<{ enabled: boolean }>(
    `SELECT (EXISTS(SELECT 1 FROM public.app_feature_flags WHERE key='PRODUCTION_WORKBENCH' AND enabled)
    OR EXISTS(SELECT 1 FROM public.ordres_fabrication WHERE id=$1::bigint AND preparation_rules_version IS NOT NULL)) AS enabled`,
    [id ?? null],
  );
  return result.rows[0]?.enabled === true;
}

export async function assertOfPreparationReady(tx: Db, id: number) {
  // Lock the shared revision before evaluating, so edits cannot race the freeze.
  const of = await loadPreparationOrder(tx, id);
  if (of.version_id)
    await tx.query(
      "SELECT id FROM public.piece_technique_versions WHERE id=$1::uuid FOR UPDATE",
      [of.version_id],
    );
  const evaluation = await persistPreparationEvaluation(tx, id);
  if (!evaluation.ready)
    throw new HttpError(
      422,
      "OF_TECHNICAL_PREPARATION_INCOMPLETE",
      "Le dossier technique contient encore des actions à terminer.",
      {
        missing_sections: evaluation.items
          .filter((i) => i.required && i.status !== "READY")
          .map((i) => i.key),
      },
    );
  return evaluation;
}
export type PreparationOrder = {
  id: number;
  numero: string;
  statut: string;
  technical_readiness: string;
  piece_technique_id: string;
  article_id: string | null;
  client_id: string | null;
  version_id: string | null;
  quantite_lancee: number;
  updated_at: string;
  technical_snapshot_sha256: string | null;
  preparation_rules_version: number | null;
  technical_snapshot?: {
    preparation_evidence?: TechnicalSources;
    preparation_decisions?: PreparationDecisions;
  };
};
type TechnicalSources = {
  version: {
    id: string;
    statut: string;
    is_current: boolean;
    manufacturing_mode: string;
    indice: string;
    updated_at: string;
    effective?: boolean;
    date_effet?: string | null;
    document_requirements_frozen_at?: string | null;
  } | null;
  purchases: PurchaseEvidence[];
  documents: Array<{
    id: string;
    version_id: string;
    role: string;
    sha256: string | null;
  }>;
  operations: Array<{
    id: string;
    designation: string;
    machine_family_code: string | null;
    cf_id: string | null;
    tp: number;
    tf_unit: number;
    numero_programme: string | null;
  }>;
  gamme: { id: string; statut: string; is_current: boolean } | null;
  components: Array<{
    id: string;
    quantite: number;
    child_piece_technique_id: string | null;
    child_article_id: string | null;
  }>;
  quality_plan: {
    id: string;
    code: string;
    version: number;
    label: string;
  } | null;
  characteristics: Array<Record<string, unknown>>;
  missing_documents: number;
  programming_task_valid: boolean;
};
export type StockCandidate = {
  lot_id: string;
  lot_code: string;
  article_id: string;
  piece_technique_version_id: string | null;
  indice: string | null;
  stock_scope: string;
  lot_status: string;
  qty_available: number;
  warehouse_id: string;
  location_id: string;
  stock_level_id: string;
  stock_batch_id: string | null;
};

export async function preparationAudit(
  tx: Db,
  audit: AuditContext,
  ofId: number,
  action: string,
  details: Record<string, unknown>,
) {
  const log = await repoInsertAuditLog({
    ...audit,
    tx,
    body: {
      event_type: "ACTION",
      action,
      entity_type: "ordres_fabrication",
      entity_id: String(ofId),
      details,
      page_key: audit.page_key,
      path: audit.path,
      client_session_id: audit.client_session_id,
    },
  });
  if (log)
    await enqueueProductionOfChanged(tx, {
      ofId,
      auditId: log.id,
      action: "updated",
      occurredAt: log.created_at,
    });
}

export async function loadPreparationOrder(
  tx: Db,
  id: number,
  lock = false,
): Promise<PreparationOrder> {
  const row = (
    await tx.query<PreparationOrder>(
      `SELECT o.id::bigint::int AS id,o.numero,o.statut::text,o.technical_readiness,o.piece_technique_id::text,o.article_id::text,o.client_id,
    COALESCE(o.piece_technique_version_id,NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,
      NULLIF(o.technical_preparation->>'selected_draft_version_id','')::uuid,
      (SELECT v.id FROM public.piece_technique_versions v WHERE v.piece_technique_id=o.piece_technique_id
       AND v.statut<>'OBSOLETE' ORDER BY v.is_current DESC,v.created_at DESC,v.id LIMIT 1))::text AS version_id,
    o.quantite_lancee::float8,o.updated_at::text,o.technical_snapshot_sha256,o.preparation_rules_version,o.technical_snapshot
    FROM public.ordres_fabrication o WHERE o.id=$1 ${lock ? "FOR UPDATE OF o" : ""}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "OF_NOT_FOUND", "OF introuvable.");
  return row;
}
export function assertPreparationMutable(
  of: PreparationOrder,
  expected: string,
) {
  if (of.updated_at !== expected)
    throw new HttpError(
      409,
      "CONCURRENT_MODIFICATION",
      "Cet OF a changé. Rechargez le dossier avant de sauvegarder.",
    );
  if (of.statut !== "BROUILLON")
    throw new HttpError(
      409,
      "OF_PREPARATION_LOCKED",
      "La préparation est verrouillée après planification.",
    );
}

export async function loadStockCandidates(
  tx: Db,
  of: PreparationOrder,
): Promise<StockCandidate[]> {
  return (
    await tx.query<StockCandidate>(
      `SELECT a.lot_id::text,l.lot_code,a.article_id::text,l.piece_technique_version_id::text,v.indice,
    CASE WHEN l.origin_stock_scope='OLD' THEN 'OLD' ELSE COALESCE(l.source_scope,l.stock_scope,w.stock_scope,'NEW') END AS stock_scope,
    COALESCE(l.lot_status,'LIBERE') AS lot_status,a.qty_available::float8,a.warehouse_id::text,a.location_id::text,a.stock_level_id::text,a.stock_batch_id::text
    FROM public.v_stock_availability_225 a JOIN public.lots l ON l.id=a.lot_id
    JOIN public.warehouses w ON w.id=a.warehouse_id JOIN public.articles article ON article.id=a.article_id
    LEFT JOIN public.piece_technique_versions v ON v.id=l.piece_technique_version_id
    WHERE article.piece_technique_id=$1::uuid AND a.managed_in_stock AND a.qty_available>0
    ORDER BY l.id,a.stock_level_id,a.stock_batch_id`,
      [of.piece_technique_id],
    )
  ).rows;
}

export async function evaluateOfPreparation(tx: Db, id: number) {
  const of = await loadPreparationOrder(tx, id);
  const profile = (
    await tx.query<{
      decisions: PreparationDecisions;
      version: number;
      approved_source_hash: string | null;
    }>(
      "SELECT decisions,version,approved_source_hash FROM public.piece_version_preparation WHERE piece_technique_version_id=$1::uuid",
      [of.version_id],
    )
  ).rows[0];
  const decisions =
    of.technical_snapshot?.preparation_decisions ?? profile?.decisions ?? {};
  const { rows } = await tx.query<{ sources: TechnicalSources }>(
    `
    WITH v AS (SELECT * FROM public.piece_technique_versions WHERE id=$1::uuid AND piece_technique_id=$2::uuid),
    g AS (SELECT * FROM public.gammes WHERE piece_technique_version_id=$1::uuid AND is_current ORDER BY created_at DESC,id LIMIT 1),
    docs AS (SELECT d.id::text,dv.id::text AS version_id,l.link_role AS role,blob.sha256
      FROM public.ged_document_links l JOIN public.ged_documents d ON d.id=l.document_id AND d.archived_at IS NULL
      JOIN public.ged_document_versions dv ON dv.id=d.current_version_id AND dv.status='APPLICABLE'
      JOIN public.ged_blobs blob ON blob.id=dv.blob_id
      JOIN public.ged_upload_sessions us ON us.id=dv.upload_session_id AND us.scan_status='clean' AND us.quarantine_status='released'
      WHERE l.entity_type='PIECE_TECHNIQUE_VERSION' AND l.entity_id=$1::text),
    qp AS (SELECT q.* FROM public.quality_control_plan q WHERE q.piece_version_id=$1::uuid AND q.status='PUBLISHED'
      AND q.archived_at IS NULL AND (q.effective_from IS NULL OR q.effective_from<=now()) AND (q.effective_to IS NULL OR q.effective_to>now())
      AND q.trigger_type IN ('IN_PROCESS','FINAL','FIRST_ARTICLE') ORDER BY q.published_at DESC,q.id LIMIT 1)
    SELECT jsonb_build_object('version',(SELECT to_jsonb(v)||jsonb_build_object('effective',v.date_effet IS NULL OR v.date_effet<=CURRENT_DATE) FROM v),'gamme',(SELECT to_jsonb(g) FROM g),
      'purchases',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.phase,p.id) FROM public.pieces_techniques_achats p WHERE p.piece_technique_id=$2::uuid AND p.piece_technique_version_id=$1::uuid),'[]'),
      'documents',COALESCE((SELECT jsonb_agg(to_jsonb(docs) ORDER BY docs.id,docs.role) FROM docs),'[]'),
      'operations',COALESCE((SELECT jsonb_agg(to_jsonb(op) ORDER BY op.phase,op.id) FROM public.pieces_techniques_operations op WHERE op.gamme_id=(SELECT id FROM g)),'[]'),
      'components',COALESCE((SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object('child_code',COALESCE(cp.code_piece,ca.code),'child_designation',COALESCE(cp.designation,ca.designation)) ORDER BY b.rang,b.id) FROM public.pieces_techniques_nomenclature b LEFT JOIN public.pieces_techniques cp ON cp.id=b.child_piece_technique_id LEFT JOIN public.articles ca ON ca.id=b.child_article_id WHERE b.parent_piece_technique_version_id=$1::uuid),'[]'),
      'quality_plan',(SELECT to_jsonb(qp) FROM qp),
      'characteristics',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.position,c.id) FROM public.quality_control_plan_characteristic c WHERE c.plan_id=(SELECT id FROM qp)),'[]'),
      'missing_documents',(SELECT count(*) FROM public.piece_version_document_requirements r WHERE r.piece_technique_version_id=$1::uuid AND NOT EXISTS(SELECT 1 FROM docs WHERE role=r.document_type_code)),
      'programming_task_valid',EXISTS(SELECT 1 FROM public.piece_version_programming_tasks p JOIN public.users u ON u.id=p.assignee_id AND u.status='Active' WHERE p.id=$3::uuid AND p.piece_technique_version_id=$1::uuid AND p.estimated_hours>0)
    ) AS sources`,
    [
      of.version_id,
      of.piece_technique_id,
      decisions.programming?.task_id ?? null,
    ],
  );
  const sources =
    of.technical_snapshot?.preparation_evidence ?? rows[0].sources;
  const sharedHash = sourceHash({
    rules: PREPARATION_RULES_VERSION,
    sources,
    decisions,
  });
  const candidates = await loadStockCandidates(tx, of);
  const stockHash = sourceHash({
    version: of.version_id,
    quantity: of.quantite_lancee,
    candidates,
  });
  const sheetHash = sourceHash({
    sharedHash,
    of_id: id,
    quantity: of.quantite_lancee,
  });
  const stockReview =
    (
      await tx.query<{ source_hash: string; decision: string; reason: string }>(
        "SELECT source_hash,decision,reason FROM public.of_stock_reviews WHERE of_id=$1",
        [id],
      )
    ).rows[0] ?? null;
  const sheet =
    (
      await tx.query<{ id: string; state: string; error_code: string | null }>(
        "SELECT id::text,state,error_code FROM public.of_self_inspection_sheets WHERE of_id=$1 AND source_hash=$2",
        [id, sheetHash],
      )
    ).rows[0] ?? null;
  const f: PreparationFacts = {
    version_id: of.version_id,
    version_status: sources.version?.statut ?? null,
    version_current: Boolean(
      sources.version?.is_current && sources.version.effective !== false,
    ),
    manufacturing_mode: sources.version?.manufacturing_mode ?? "SIMPLE",
    decisions,
    purchases: sources.purchases,
    client_plan_count: sources.documents.filter((d) =>
      ["PLAN_CLIENT", "PLAN", "TECHNICAL_DRAWING"].includes(d.role),
    ).length,
    manufacturing_plan_count: sources.documents.filter((d) =>
      ["PLAN_FABRICATION", "MANUFACTURING_DRAWING"].includes(d.role),
    ).length,
    required_documents_missing: Number(sources.missing_documents),
    routing_count:
      sources.gamme?.statut === "APPLICABLE" && sources.gamme.is_current
        ? sources.operations.length
        : 0,
    invalid_operations: sources.operations.filter(
      (o) =>
        !o.designation?.trim() ||
        !o.cf_id ||
        !o.machine_family_code ||
        Number(o.tp) < 0 ||
        Number(o.tf_unit) < 0 ||
        Number(o.tp) + Number(o.tf_unit) <= 0,
    ).length,
    component_count: sources.components.length,
    invalid_components: sources.components.filter(
      (c) =>
        Number(c.quantite) <= 0 ||
        (!c.child_article_id && !c.child_piece_technique_id),
    ).length,
    quality_plan_id: sources.quality_plan?.id ?? null,
    quality_characteristic_count: sources.characteristics.every(
      (c) =>
        c.characteristic_key !== "INIT-01" &&
        Boolean(String(c.label ?? "").trim()) &&
        String(c.label).trim() !== "À compléter",
    )
      ? sources.characteristics.length
      : 0,
    programming_task_valid: sources.programming_task_valid,
    programming_reference_valid: sources.operations.some(
      (op) => op.numero_programme === decisions.programming?.reference,
    ),
    stock_review_current:
      stockReview?.decision !== "REWORK" &&
      (of.technical_snapshot_sha256
        ? Boolean(stockReview)
        : stockReview?.source_hash === stockHash),
    sheet_current: sheet?.state === "READY",
  };
  const items = evaluatePreparation(f);
  const sharedReady = isPreparationReady(
    items.filter((i) => i.scope === "VERSION"),
  );
  const programmingTask =
    (
      await tx.query(
        `SELECT p.id::text,p.assignee_id,p.estimated_hours::float8,p.status,p.program_reference,p.updated_at::text,concat_ws(' ',u.name,u.surname) AS assignee_name
    FROM public.piece_version_programming_tasks p JOIN public.users u ON u.id=p.assignee_id WHERE p.piece_technique_version_id=$1::uuid`,
        [of.version_id],
      )
    ).rows[0] ?? null;
  const programmers = (
    await tx.query(
      `SELECT id,COALESCE(NULLIF(trim(concat_ws(' ',name,surname)),''),username) AS name FROM public.users WHERE status='Active' AND lower(role) SIMILAR TO '%(admin|directeur|program|method|méthod|production)%' ORDER BY name,id LIMIT 200`,
    )
  ).rows;
  const purchaseSources = (
    await tx.query(
      `SELECT p.piece_technique_version_id::text AS version_id,v.indice,count(*)::int AS count FROM public.pieces_techniques_achats p LEFT JOIN public.piece_technique_versions v ON v.id=p.piece_technique_version_id WHERE p.piece_technique_id=$1::uuid AND p.piece_technique_version_id IS DISTINCT FROM $2::uuid GROUP BY p.piece_technique_version_id,v.indice ORDER BY v.indice NULLS FIRST`,
      [of.piece_technique_id, of.version_id],
    )
  ).rows;
  const stockReuseDecisions = (
    await tx.query(
      `SELECT d.id::text,d.quantity::float8,l.lot_code,d.disposition,d.justification,d.approval_reference,d.created_at::text FROM public.of_stock_reuse_decisions d JOIN public.lots l ON l.id=d.lot_id WHERE d.of_id=$1 ORDER BY d.created_at DESC,d.id`,
      [id],
    )
  ).rows;
  const sharedImpact = (
    await tx.query<{ mutable_of_ids: number[]; frozen_count: number }>(
      `SELECT COALESCE(array_agg(o.id::bigint::int ORDER BY o.id) FILTER(WHERE o.statut='BROUILLON' AND o.technical_snapshot_sha256 IS NULL),'{}'::int[]) AS mutable_of_ids,
      count(*) FILTER(WHERE o.technical_snapshot_sha256 IS NOT NULL)::int AS frozen_count
     FROM public.ordres_fabrication o WHERE o.piece_technique_id=$1::uuid AND o.statut NOT IN ('ANNULE','TERMINE','CLOTURE')
     AND COALESCE(o.piece_technique_version_id,NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,
       (SELECT v.id FROM public.piece_technique_versions v WHERE v.piece_technique_id=$1::uuid AND v.statut<>'OBSOLETE' ORDER BY v.is_current DESC,v.created_at DESC,v.id LIMIT 1))=$2::uuid`,
      [of.piece_technique_id, of.version_id],
    )
  ).rows[0];
  const consolidation = (
    await tx.query<{ id: string }>(
      `SELECT id::text FROM public.production_consolidations WHERE producer_of_id=$1`,
      [id],
    )
  ).rows[0];
  return {
    of,
    version: sources.version,
    profile_version: profile?.version ?? 0,
    decisions,
    items,
    ready: isPreparationReady(items),
    shared_ready: sharedReady,
    shared_impact: sharedImpact,
    shared_approved:
      sharedReady && profile?.approved_source_hash === sharedHash,
    rules_version: PREPARATION_RULES_VERSION,
    source_hash: sharedHash,
    stock_hash: stockHash,
    sheet_hash: sheetHash,
    stock_candidates: candidates,
    stock_review: stockReview,
    sheet,
    sources,
    programming_task: programmingTask,
    programmers,
    purchase_sources: purchaseSources,
    stock_reuse_decisions: stockReuseDecisions,
    consolidation_id: consolidation?.id ?? null,
    evaluated_at: new Date().toISOString(),
  };
}

export async function persistPreparationEvaluation(tx: Db, id: number) {
  const evaluation = await evaluateOfPreparation(tx, id);
  await tx.query(
    `INSERT INTO public.of_preparation_evaluations(of_id,piece_technique_version_id,rules_version,source_hash,items,ready)
    VALUES($1,$2::uuid,$3,$4,$5::jsonb,$6) ON CONFLICT(of_id) DO UPDATE SET piece_technique_version_id=excluded.piece_technique_version_id,
    rules_version=excluded.rules_version,source_hash=excluded.source_hash,items=excluded.items,ready=excluded.ready,evaluated_at=now()`,
    [
      id,
      evaluation.of.version_id,
      PREPARATION_RULES_VERSION,
      evaluation.source_hash,
      JSON.stringify(evaluation.items),
      evaluation.ready,
    ],
  );
  return evaluation;
}

export async function repoPreparationWorkbench(id: number) {
  return evaluateOfPreparation(pool, id);
}

export async function repoSavePreparationDecisions(
  id: number,
  input: {
    expected_updated_at: string;
    version_id: string;
    expected_version: number;
    decisions: PreparationDecisions;
  },
  audit: AuditContext,
) {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const of = await loadPreparationOrder(tx, id, true);
    assertPreparationMutable(of, input.expected_updated_at);
    if (of.technical_snapshot_sha256)
      throw new HttpError(
        409,
        "TECHNICAL_SNAPSHOT_FROZEN",
        "Créez une révision pour modifier une définition déjà figée.",
      );
    if (of.version_id !== input.version_id)
      throw new HttpError(
        409,
        "OF_VERSION_CONFLICT",
        "L’indice sélectionné a changé.",
      );
    await tx.query(
      "SELECT id FROM public.piece_technique_versions WHERE id=$1::uuid FOR UPDATE",
      [input.version_id],
    );
    const current = (
      await tx.query<{ version: number; decisions: PreparationDecisions }>(
        "SELECT version,decisions FROM public.piece_version_preparation WHERE piece_technique_version_id=$1::uuid FOR UPDATE",
        [input.version_id],
      )
    ).rows[0];
    if ((current?.version ?? 0) !== input.expected_version)
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "La préparation de cette pièce a changé. Rechargez les données.",
      );
    await tx.query(
      `INSERT INTO public.piece_version_preparation(piece_technique_version_id,decisions,updated_by)
      VALUES($1::uuid,$2::jsonb,$3) ON CONFLICT(piece_technique_version_id) DO UPDATE SET decisions=excluded.decisions,version=piece_version_preparation.version+1,
      approved_source_hash=NULL,approved_at=NULL,approved_by=NULL,updated_at=now(),updated_by=excluded.updated_by`,
      [
        input.version_id,
        JSON.stringify({ ...current?.decisions, ...input.decisions }),
        audit.user_id,
      ],
    );
    const affected = await invalidateCompatibleDrafts(
      tx,
      of.piece_technique_id,
      input.version_id,
      audit,
    );
    await preparationAudit(
      tx,
      audit,
      id,
      "production.preparation.decisions.save",
      { version_id: input.version_id, affected_of_ids: affected },
    );
    return {
      ...(await persistPreparationEvaluation(tx, id)),
      affected_of_ids: affected,
    };
  });
}

export async function invalidateCompatibleDrafts(
  tx: Db,
  pieceId: string,
  versionId: string,
  audit: AuditContext,
) {
  const rows = (
    await tx.query<{ id: number }>(
      `UPDATE public.ordres_fabrication SET technical_readiness='INCOMPLETE',technical_submitted_at=NULL,technical_submitted_by=NULL,
    updated_at=now(),updated_by=$3 WHERE piece_technique_id=$1::uuid AND statut='BROUILLON' AND technical_snapshot_sha256 IS NULL
    AND COALESCE(NULLIF(technical_preparation->>'selected_version_id','')::uuid,NULLIF(technical_preparation->>'selected_draft_version_id','')::uuid)=$2::uuid
    RETURNING id::bigint::int AS id`,
      [pieceId, versionId, audit.user_id],
    )
  ).rows;
  await tx.query(
    "DELETE FROM public.of_preparation_evaluations WHERE of_id=ANY($1::bigint[])",
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => r.id);
}

export async function repoSelectPreparationVersion(
  id: number,
  input: { expected_updated_at: string; version_id: string },
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    const of = await loadPreparationOrder(tx, id, true);
    assertPreparationMutable(of, input.expected_updated_at);
    if (of.technical_snapshot_sha256)
      throw new HttpError(
        409,
        "TECHNICAL_SNAPSHOT_FROZEN",
        "La définition de cet OF est figée.",
      );
    const version = (
      await tx.query(
        "SELECT id FROM public.piece_technique_versions WHERE id=$1::uuid AND piece_technique_id=$2::uuid AND statut<>'OBSOLETE' FOR SHARE",
        [input.version_id, of.piece_technique_id],
      )
    ).rows[0];
    if (!version)
      throw new HttpError(
        422,
        "OF_VERSION_CONFLICT",
        "Cette révision ne correspond pas à la pièce de l’OF.",
      );
    await tx.query(
      `UPDATE public.ordres_fabrication SET technical_preparation=technical_preparation||jsonb_build_object('selected_version_id',$2::text),
      preparation_rules_version=$3,technical_readiness='INCOMPLETE',updated_at=now(),updated_by=$4 WHERE id=$1`,
      [id, input.version_id, PREPARATION_RULES_VERSION, audit.user_id],
    );
    await preparationAudit(
      tx,
      audit,
      id,
      "production.preparation.version.select",
      { version_id: input.version_id },
    );
    return persistPreparationEvaluation(tx, id);
  });
}

export async function repoReviewPreparationStock(
  id: number,
  input: { expected_updated_at: string; source_hash: string; reason: string },
  audit: AuditContext,
) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    const of = await loadPreparationOrder(tx, id, true);
    assertPreparationMutable(of, input.expected_updated_at);
    const evaluation = await evaluateOfPreparation(tx, id);
    if (evaluation.stock_hash !== input.source_hash)
      throw new HttpError(
        409,
        "STOCK_CHANGED",
        "Les disponibilités ont changé. Examinez les lots actualisés.",
      );
    await tx.query(
      `INSERT INTO public.of_stock_reviews(of_id,source_hash,decision,reason,reviewed_by) VALUES($1,$2,'NO_REUSE',$3,$4)
      ON CONFLICT(of_id) DO UPDATE SET source_hash=excluded.source_hash,decision=excluded.decision,reason=excluded.reason,reviewed_at=now(),reviewed_by=excluded.reviewed_by`,
      [id, input.source_hash, input.reason, audit.user_id],
    );
    await tx.query(
      "UPDATE public.ordres_fabrication SET updated_at=now(),updated_by=$2 WHERE id=$1",
      [id, audit.user_id],
    );
    await preparationAudit(
      tx,
      audit,
      id,
      "production.preparation.stock.review",
      {
        decision: "NO_REUSE",
        reason: input.reason,
        source_hash: input.source_hash,
      },
    );
    return persistPreparationEvaluation(tx, id);
  });
}
