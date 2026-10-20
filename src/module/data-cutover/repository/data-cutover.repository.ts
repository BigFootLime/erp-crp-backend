import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { duplicateCutoverTargets, hashCutover, inspectCutoverRow, requiredChecklist, summarizeCutover } from "../domain/cutover-validation";
import { catalogFor } from "../domain/cutover-catalog";
import { canonicalizeStockUnitCode } from "../../../shared/stock-unit";
import type { CutoverAccess, CutoverBatch, CutoverDomain, CutoverPreview, CutoverRow } from "../types/data-cutover.types";
import type { CreateCutoverBatch, PatchCutoverRow, ValidateCutover } from "../validators/data-cutover.validators";
import { linkCutoverEvidenceTx, listEvidenceTx } from "../application/evidence/evidence.repository";
import { getFinancialCutoverStatusTx, startFinancialCutoverPreparationTx } from "../../facturation/repository/financial-cutover-guard";
import { listCutoverOpeningStatesTx } from "../application/openings/openings.repository";
import { readWipPreparationContextTx } from "../application/openings/wip-preparation.contract";
import { buildConfirmedWipCheckpoints } from "../application/openings/wip-preparation.contract";
import { createCutoverDeliveryTargetTx, applyNativeRemainderTx, previewNativeRemainderTx } from "../../commande-client/repository/commande-client.repository";
import type { NativeRemainderApplyInput } from "../validators/data-cutover.validators";

type StoredBatch = Omit<CutoverBatch, "summary"> & { preview_hash: string | null; preview_payload: CutoverPreview | null; validation: unknown };
type StoredRow = Omit<CutoverRow, "status" | "issues">;

async function transaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "42P01") throw new HttpError(503, "CUTOVER_NOT_INSTALLED", "L'espace de préparation n'est pas encore installé. Aucune donnée métier n'a été modifiée.");
    throw error;
  } finally { tx.release(); }
}

async function audit(tx: PoolClient, batchId: string, rowId: string | null, actorId: number, action: string, details: Record<string, unknown>): Promise<void> {
  await tx.query("INSERT INTO public.data_cutover_events(batch_id,row_id,actor_user_id,action,details) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb)", [batchId, rowId, actorId, action, JSON.stringify(details)]);
}

async function command<T>(actorId: number, operation: string, key: string, input: unknown, fn: (tx: PoolClient) => Promise<T>, authorize?: (tx: PoolClient) => Promise<void>): Promise<T> {
  const requestHash = hashCutover(input);
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cutover:${actorId}:${operation}:${key}`]);
    if (authorize) await authorize(tx);
    const existing = await tx.query<{ request_hash: string; response: T }>("SELECT request_hash,response FROM public.data_cutover_commands WHERE actor_user_id=$1 AND operation=$2 AND idempotency_key=$3", [actorId, operation, key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new HttpError(409, "CUTOVER_IDEMPOTENCY_CONFLICT", "Cette demande a déjà été utilisée avec un autre contenu. Rechargez le dossier.");
      return existing.rows[0].response;
    }
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cutover:rate:${actorId}`]);
    const usage = await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM public.data_cutover_commands WHERE actor_user_id=$1 AND created_at>now()-interval '1 minute'", [actorId]);
    if ((usage.rows[0]?.count ?? 0) >= 120) throw new HttpError(429, "CUTOVER_RATE_LIMITED", "Trop de modifications rapprochées. Attendre une minute avant de continuer.");
    const response = await fn(tx);
    await tx.query("INSERT INTO public.data_cutover_commands(actor_user_id,operation,idempotency_key,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)", [actorId, operation, key, requestHash, JSON.stringify(response)]);
    return response;
  });
}

async function getBatch(tx: PoolClient, id: string, lock = false): Promise<StoredBatch> {
  const result = await tx.query<StoredBatch>(`SELECT id::text,name,source_system,status,version,sources,cutoff_at::text,created_at::text,updated_at::text,created_by,preview_hash,preview_payload,validation FROM public.data_cutover_batches WHERE id=$1::uuid${lock ? " FOR UPDATE" : ""}`, [id]);
  const batch = result.rows[0];
  if (!batch) throw new HttpError(404, "CUTOVER_BATCH_NOT_FOUND", "Dossier de reprise introuvable.");
  return batch;
}
async function getRows(tx: PoolClient, id: string, options: { domains?: CutoverDomain[] | null; ids?: string[]; includedOnly?: boolean } = {}): Promise<CutoverRow[]> {
  const result = await tx.query<StoredRow>(`SELECT id::text,batch_id::text,domain,legacy_key,source_id,sheet,row_number,source_values,"values",source_issues,source_notes,decision,review_note,version FROM public.data_cutover_rows WHERE batch_id=$1::uuid AND ($2::text[] IS NULL OR domain=ANY($2::text[])) AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])) AND (NOT $4::boolean OR decision='INCLUDE') ORDER BY domain,row_number,id`, [id, options.domains ?? null, options.ids ?? null, options.includedOnly === true]);
  const units = await listUnits(tx);
  const rows = result.rows.map((row) => inspectCutoverRow(row, { allowedUnits: units.map((unit) => unit.code) }));
  await verifyReferenceTargets(tx, rows);
  return rows;
}

async function listUnits(tx: Pick<PoolClient, "query">): Promise<Array<{ code: string; label: string }>> {
  const result = await tx.query<{ code: string; label: string }>("SELECT code,label FROM public.units ORDER BY code");
  const units = new Map<string, { code: string; label: string }>();
  for (const row of result.rows) {
    const code = canonicalizeStockUnitCode(row.code);
    if (code && !units.has(code)) units.set(code, { code, label: row.label || code });
  }
  return [...units.values()];
}
export async function repoCutoverUnits() { return listUnits(pool); }
export async function repoCutoverFinancialStatus() {
  return transaction(async (tx) => {
    const { phase } = await getFinancialCutoverStatusTx(tx);
    return { status: phase, emissions_suspended: phase === "PREPARING" };
  });
}
export async function repoCutoverArticleFamilies() {
  const result = await pool.query<{ category: string; code: string }>(`SELECT 'fabrique'::text AS category,code FROM public.articles_fabrique_families WHERE is_active
    UNION ALL SELECT 'achat',code FROM public.articles_achat_families WHERE is_active
    UNION ALL SELECT 'traitement',code FROM public.articles_traitement_families WHERE is_active
    UNION ALL SELECT 'matiere',code FROM public.articles_matiere_families WHERE is_active ORDER BY category,code`);
  const grouped: Record<string, string[]> = {};
  for (const row of result.rows) (grouped[row.category] ??= []).push(row.code);
  return grouped;
}

const lookupQueries = {
  CUSTOMER: "SELECT client_id::text AS id,COALESCE(client_code,client_id::text) AS code,company_name AS label FROM public.clients",
  SUPPLIER: "SELECT id::text AS id,COALESCE(code,code_fournisseur,id::text) AS code,COALESCE(nom,raison_sociale,'') AS label FROM public.fournisseurs",
  ARTICLE: "SELECT id::text AS id,code,designation AS label FROM public.articles",
  TECHNICAL_PIECE: "SELECT id::text AS id,COALESCE(to_jsonb(p)->>'code',to_jsonb(p)->>'code_piece',name_piece,id::text) AS code,COALESCE(designation,name_piece,'') AS label FROM public.pieces_techniques p WHERE deleted_at IS NULL",
  CONTRACT: "SELECT id::text AS id,reference AS code,title AS label FROM public.client_contracts WHERE status IN ('DRAFT','ACTIVE')",
  TECHNICAL_VERSION: "SELECT v.id::text AS id,concat_ws(' / ',p.code_piece,v.plan_reference,NULLIF(v.indice,'')) AS code,concat('Version ',v.version_interne,' - ',v.statut) AS label FROM public.piece_technique_versions v JOIN public.pieces_techniques p ON p.id=v.piece_technique_id WHERE v.statut IN ('APPLICABLE','OBSOLETE') AND p.deleted_at IS NULL",
  NATIVE_ORDER: "SELECT id::text AS id,numero AS code,concat('Commande ',order_type) AS label FROM public.commande_client",
  NATIVE_ORDER_LINE: "SELECT l.id::text AS id,concat(c.numero,' / ',COALESCE(l.code_piece,l.id::text)) AS code,l.designation AS label FROM public.commande_ligne l JOIN public.commande_client c ON c.id=l.commande_id",
  DELIVERY_AFFAIR: "SELECT id::text AS id,reference AS code,reference AS label FROM public.affaire WHERE type_affaire='livraison'",
} as const;
export type CutoverLookupEntity = keyof typeof lookupQueries;
export async function repoCutoverLookup(entity: CutoverLookupEntity, search: string) {
  const query = lookupQueries[entity];
  const result = await pool.query<{ id: string; code: string; label: string }>(`SELECT id,code,label FROM (${query}) lookup WHERE strpos(lower(COALESCE(code,'') || ' ' || COALESCE(label,'')),lower($1))>0 ORDER BY code,id LIMIT 30`, [search]);
  return { items: result.rows };
}
async function verifyReferenceTargets(tx: PoolClient, rows: CutoverRow[]): Promise<void> {
  for (const entity of Object.keys(lookupQueries) as CutoverLookupEntity[]) {
    const fields = rows.flatMap((row) => catalogFor(row.domain).fields.filter((field) => field.lookup_entity === entity).flatMap((field) => typeof row.values[field.key] === "string" && row.values[field.key] ? [{ row, field, value: row.values[field.key] as string }] : []));
    if (!fields.length) continue;
    const ids = [...new Set(fields.map((field) => field.value))];
    const result = await tx.query<{ id: string }>(`SELECT id FROM (${lookupQueries[entity]}) lookup WHERE id=ANY($1::text[])`, [ids]);
    const found = new Set(result.rows.map((row) => row.id));
    for (const { row, field, value } of fields) if (!found.has(value)) {
      row.issues.push({ field: field.key, code: "TARGET_NOT_FOUND", message: "La fiche CERP sélectionnée n'existe plus ou n'est pas disponible. Refaire le rapprochement." });
      if (row.decision === "INCLUDE") row.status = "MISSING";
    }
  }
}
async function allowedDomains(tx: PoolClient, batchId: string, access: CutoverAccess): Promise<CutoverDomain[] | null> {
  if (access.isSuperadmin) return null;
  const result = await tx.query<{ domain: CutoverDomain }>("SELECT domain FROM public.data_cutover_contributors WHERE batch_id=$1::uuid AND user_id=$2", [batchId, access.userId]);
  if (!result.rows.length) throw new HttpError(404, "CUTOVER_BATCH_NOT_FOUND", "Dossier de reprise introuvable.");
  return result.rows.map((row) => row.domain);
}
export async function repoGetCutoverWipContext(batchId: string, rowId: string, chosenVersionId: string | undefined, access: CutoverAccess, quantity?: string, orderId?: string) {
  return transaction(async (tx) => {
    await getBatch(tx, batchId);
    const domains = await allowedDomains(tx, batchId, access);
    if (domains && !domains.includes("WIP")) throw new HttpError(404, "CUTOVER_ROW_NOT_FOUND", "Fiche de reprise introuvable.");
    const row = (await getRows(tx, batchId, { domains: ["WIP"], ids: [rowId] }))[0];
    if (!row) throw new HttpError(404, "CUTOVER_ROW_NOT_FOUND", "Fiche de reprise introuvable.");
    if (!access.isSuperadmin && chosenVersionId && chosenVersionId !== row.values.historicalVersionId) throw new HttpError(403, "CUTOVER_SUPERADMIN_MAPPING_REQUIRED", "Le SuperAdmin choisit la version technique rapprochée.");
    if (!access.isSuperadmin && orderId && orderId !== row.values.affairTargetId) throw new HttpError(403, "CUTOVER_SUPERADMIN_MAPPING_REQUIRED", "Le SuperAdmin choisit la commande rapprochée.");
    return readWipPreparationContextTx(tx, { ...row, values: { ...row.values, ...(quantity === undefined ? {} : { quantityRemaining: quantity }), ...(orderId === undefined ? {} : { affairTargetId: orderId }) } }, chosenVersionId);
  });
}
async function assertNativeRemainderProvenanceTx(tx: PoolClient, batchId: string, commandeId: string): Promise<void> {
  const native = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM public.data_cutover_application_crosswalk
      WHERE target_type='COMMANDE_CLIENT' AND target_id=$1::text LIMIT 1 FOR KEY SHARE`, [commandeId],
  );
  if (!native.rows[0]) throw new HttpError(409, "CUTOVER_NATIVE_ORDER_PROVENANCE_REQUIRED", "Cette commande n'est pas issue d'une reprise CLIPPER/Excel reconnue.");
  const wip = await tx.query<{ id: string; decision: string; prepared: boolean }>(
    `SELECT row.id::text AS id,row.decision,
            NULLIF(row."values"->>'livraisonAffaireId','') IS NOT NULL AS prepared
       FROM public.data_cutover_rows row
      WHERE row.domain='WIP' AND row.decision<>'EXCLUDE'
        AND (row."values"->>'affairTargetId'=$1 OR row."values"->>'commandeId'=$1)
        AND (row.decision='PENDING' OR NULLIF(row."values"->>'livraisonAffaireId','') IS NULL)
      ORDER BY row.decision,row.row_number,row.id LIMIT 1 FOR KEY SHARE`, [commandeId],
  );
  if (wip.rows[0]?.decision === "PENDING") throw new HttpError(409, "CUTOVER_WIP_DECISION_REQUIRED", "Toute cohorte WIP de cette commande doit être explicitement incluse ou exclue avant de préparer un OF neuf.");
  if (wip.rows[0] && !wip.rows[0].prepared) throw new HttpError(409, "CUTOVER_WIP_TARGET_NOT_PREPARED", "Toutes les cohortes WIP incluses de cette commande doivent d'abord avoir une affaire de livraison persistée.");
  await getBatch(tx, batchId, true);
}
export async function repoPreviewNativeRemainder(batchId: string, commandeId: string, input: { expected_batch_version: number }, actorId: number) {
  return transaction(async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    assertVersion(batch, input.expected_batch_version);
    await assertNativeRemainderProvenanceTx(tx, batchId, commandeId);
    const preview = await previewNativeRemainderTx(tx, { commande_id: commandeId });
    const preview_hash = hashCutover({ batch_id: batchId, batch_version: batch.version, commande_id: commandeId, preview });
    await audit(tx, batchId, null, actorId, "NATIVE_REMAINDER_PREVIEWED", { commande_id: commandeId, preview_hash, blocker_count: preview.blockers.length, business_writes: false });
    return { ...preview, batch_version: batch.version, preview_hash };
  });
}
export async function repoApplyNativeRemainder(batchId: string, commandeId: string, input: NativeRemainderApplyInput, actorId: number, key: string) {
  return command(actorId, `native-remainder:${batchId}:${commandeId}`, key, input, async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    assertVersion(batch, input.expected_batch_version);
    await assertNativeRemainderProvenanceTx(tx, batchId, commandeId);
    const preview = await previewNativeRemainderTx(tx, { commande_id: commandeId });
    const preview_hash = hashCutover({ batch_id: batchId, batch_version: batch.version, commande_id: commandeId, preview });
    if (preview_hash !== input.expected_preview_hash) throw new HttpError(409, "CUTOVER_STALE_PREVIEW", "Le reliquat, le stock ou la préparation WIP a changé. Relancez l'aperçu.");
    if (preview.blockers.length) {
      const technical = preview.blockers.some((blocker) => ["PIECE_TECHNIQUE_REQUIRED", "CUTOVER_APPLICABLE_TECHNICAL_VERSION_REQUIRED", "CUTOVER_NATIVE_REMAINDER_UNIT_INVALID"].includes(blocker.code));
      throw new HttpError(technical ? 422 : 409, technical ? "CUTOVER_NATIVE_REMAINDER_TECHNICAL_BLOCKED" : "CUTOVER_NATIVE_REMAINDER_BLOCKED", "Le reliquat ne peut pas être préparé tant que les blocages affichés ne sont pas levés.", { blockers: preview.blockers });
    }
    const result = await applyNativeRemainderTx(tx, { commande_id: commandeId, user_id: actorId, expected_plan_hash: preview.plan_hash });
    if (batch.status === "VALIDATED") await invalidateValidation(tx, batch, actorId, "NATIVE_REMAINDER_APPLIED");
    const next = await tx.query<{ version: number }>(
      `UPDATE public.data_cutover_batches
          SET status='DRAFT',version=version+1,preview_hash=NULL,preview_payload=NULL,validation='{}'::jsonb,updated_at=now()
        WHERE id=$1::uuid RETURNING version`, [batchId]
    );
    await audit(tx, batchId, null, actorId, "NATIVE_REMAINDER_APPLIED", { ...result, creates_bon_livraison: false, creates_financial_document: false, creates_historical_movement: false });
    return { ...result, batch_version: next.rows[0]!.version, preview_hash };
  });
}
function assertVersion(batch: StoredBatch, expected: number): void {
  if (batch.version !== expected) throw new HttpError(409, "CUTOVER_STALE_VERSION", "Le dossier a été modifié depuis son affichage. Rechargez les données avant de continuer.");
}
async function invalidateValidation(tx: PoolClient, batch: StoredBatch, actorId: number, reason: "ROW_UPDATED" | "CONTRIBUTORS_CHANGED" | "EVIDENCE_LINKED" | "WIP_DELIVERY_TARGET_PREPARED" | "NATIVE_REMAINDER_APPLIED"): Promise<void> {
  // Keep the signed preparation evidence immutable in the audit trail. The
  // validation itself is cleared only once the reason and its prior hash have
  // been recorded, so a later reviewer can see why a signature disappeared.
  await audit(tx, batch.id, null, actorId, "PREPARATION_VALIDATION_INVALIDATED", {
    reason,
    previous_validation_hash: hashCutover(batch.validation),
    previous_batch_version: batch.version,
    business_writes: false,
  });
}
function publicBatch(batch: StoredBatch, rows: CutoverRow[]): CutoverBatch {
  const { preview_hash: _hash, preview_payload: _preview, validation: _validation, ...publicFields } = batch;
  const visibleSourceIds = new Set(rows.map((row) => row.source_id));
  return { ...publicFields, sources: batch.sources.filter((source) => visibleSourceIds.has(source.id)), summary: summarizeCutover(rows) };
}
async function loadPublicBatch(tx: PoolClient, batch: StoredBatch, access: CutoverAccess): Promise<CutoverBatch> {
  const domains = await allowedDomains(tx, batch.id, access);
  const counts = await tx.query<{ total: number; pending: number; excluded: number; sources: string[] }>(`SELECT count(*)::int AS total,count(*) FILTER(WHERE decision='PENDING')::int AS pending,count(*) FILTER(WHERE decision='EXCLUDE')::int AS excluded,COALESCE(array_agg(DISTINCT source_id),'{}'::text[]) AS sources FROM public.data_cutover_rows WHERE batch_id=$1::uuid AND ($2::text[] IS NULL OR domain=ANY($2::text[]))`, [batch.id, domains]);
  const included = await getRows(tx, batch.id, { domains, includedOnly: true });
  const count = counts.rows[0]!;
  const result = publicBatch(batch, included);
  result.summary = { ...summarizeCutover(included), total: count.total, pending: count.pending, excluded: count.excluded };
  result.sources = batch.sources.filter((source) => count.sources.includes(source.id));
  return result;
}

export async function repoListCutoverBatches(access: CutoverAccess): Promise<{ items: CutoverBatch[] }> {
  return transaction(async (tx) => {
    const ids = await tx.query<{ id: string }>("SELECT b.id::text FROM public.data_cutover_batches b WHERE $1::boolean OR EXISTS(SELECT 1 FROM public.data_cutover_contributors c WHERE c.batch_id=b.id AND c.user_id=$2) ORDER BY b.created_at DESC,b.id LIMIT 25", [access.isSuperadmin, access.userId]);
    const items: CutoverBatch[] = [];
    for (const { id } of ids.rows) items.push(await loadPublicBatch(tx, await getBatch(tx, id), access));
    return { items };
  });
}
export async function repoGetCutoverBatch(id: string, access: CutoverAccess): Promise<{ batch: CutoverBatch }> {
  return transaction(async (tx) => ({ batch: await loadPublicBatch(tx, await getBatch(tx, id), access) }));
}
export async function repoGetCutoverRows(id: string, query: { domain?: string; status?: string; search?: string; page: number; page_size: number }, access: CutoverAccess) {
  return transaction(async (tx) => {
    const batch = await getBatch(tx, id);
    const domains = await allowedDomains(tx, id, access);
    const publicView = await loadPublicBatch(tx, batch, access);
    const selectedStatus = query.status === "READY" || query.status === "MISSING";
    const statusIds = selectedStatus ? (await getRows(tx, id, { domains, includedOnly: true })).filter((row) => row.status === query.status).map((row) => row.id) : null;
    const decision = query.status === "UNDECIDED" ? "PENDING" : query.status === "EXCLUDED" ? "EXCLUDE" : null;
    const parameters = [id, domains, query.domain ?? null, query.search?.toLowerCase() ?? "", decision, statusIds];
    const where = `batch_id=$1::uuid AND ($2::text[] IS NULL OR domain=ANY($2::text[])) AND ($3::text IS NULL OR domain=$3) AND ($4::text='' OR strpos(lower(legacy_key),$4)>0 OR EXISTS(SELECT 1 FROM jsonb_each_text(r."values") v WHERE strpos(lower(COALESCE(v.value,'')),$4)>0)) AND ($5::text IS NULL OR decision=$5) AND ($6::uuid[] IS NULL OR id=ANY($6::uuid[]))`;
    const count = await tx.query<{ total: number }>(`SELECT count(*)::int AS total FROM public.data_cutover_rows r WHERE ${where}`, parameters);
    const page = await tx.query<{ id: string }>(`SELECT id::text FROM public.data_cutover_rows r WHERE ${where} ORDER BY domain,row_number,id LIMIT $7 OFFSET $8`, [...parameters, query.page_size, (query.page - 1) * query.page_size]);
    const items = await getRows(tx, id, { domains, ids: page.rows.map((row) => row.id) });
    return { items, total: count.rows[0]!.total, page: query.page, page_size: query.page_size, summary: publicView.summary };
  });
}
export async function repoCreateCutoverBatch(input: CreateCutoverBatch, actorId: number, key: string) {
  return command(actorId, "create", key, input, async (tx) => {
    const sourceHash = hashCutover({ source_system: input.source_system, sources: input.sources, rows: input.rows });
    const found = await tx.query<{ id: string }>("SELECT id::text FROM public.data_cutover_batches WHERE source_hash=$1", [sourceHash]);
    if (found.rows[0]) {
      await startFinancialCutoverPreparationTx(tx, { actorId, batchId: found.rows[0].id });
      return { batch: publicBatch(await getBatch(tx, found.rows[0].id), await getRows(tx, found.rows[0].id)), replayed: true };
    }
    const result = await tx.query<{ id: string }>("INSERT INTO public.data_cutover_batches(name,source_system,source_hash,sources,created_by) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(source_hash) DO NOTHING RETURNING id::text", [input.name, input.source_system, sourceHash, JSON.stringify(input.sources), actorId]);
    const id = result.rows[0]?.id;
    if (!id) {
      const duplicate = await tx.query<{ id: string }>("SELECT id::text FROM public.data_cutover_batches WHERE source_hash=$1", [sourceHash]);
      const duplicateId = duplicate.rows[0]!.id;
      await startFinancialCutoverPreparationTx(tx, { actorId, batchId: duplicateId });
      return { batch: publicBatch(await getBatch(tx, duplicateId), await getRows(tx, duplicateId)), replayed: true };
    }
    await startFinancialCutoverPreparationTx(tx, { actorId, batchId: id });
    // Bounded batches avoid an unbounded SQL statement while retaining one transaction.
    for (let offset = 0; offset < input.rows.length; offset += 500) {
      const rows = input.rows.slice(offset, offset + 500);
      await tx.query(`INSERT INTO public.data_cutover_rows(batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,"values",source_issues,source_notes,updated_by)
        SELECT $1::uuid,r.domain,r.legacy_key,r.source_id,r.sheet,r.row_number,r.values,r.values,r.source_issues,r.source_notes,$3
        FROM jsonb_to_recordset($2::jsonb) AS r(domain text,legacy_key text,source_id text,sheet text,row_number integer,"values" jsonb,source_issues jsonb,source_notes jsonb)`, [id, JSON.stringify(rows), actorId]);
    }
    await audit(tx, id, null, actorId, "PREPARATION_CREATED", { source_hash: sourceHash, source_count: input.sources.length, row_count: input.rows.length, business_writes: false });
    return { batch: publicBatch(await getBatch(tx, id), await getRows(tx, id)), replayed: false };
  });
}

export async function repoPatchCutoverRow(batchId: string, rowId: string, input: PatchCutoverRow, access: CutoverAccess, key: string) {
  const actorId = access.userId;
  return command(actorId, `row:${rowId}`, key, input, async (tx) => {
    const lockedBatch = await getBatch(tx, batchId, true);
    if (lockedBatch.status === "VALIDATED" && !access.isSuperadmin) {
      throw new HttpError(409, "CUTOVER_BATCH_LOCKED", "Ce dossier validé est verrouillé pour les contributeurs. Demandez au SuperAdmin de le corriger si nécessaire.");
    }
    const result = await tx.query<StoredRow>(`SELECT id::text,batch_id::text,domain,legacy_key,source_id,sheet,row_number,source_values,"values",source_issues,source_notes,decision,review_note,version FROM public.data_cutover_rows WHERE id=$1::uuid AND batch_id=$2::uuid FOR UPDATE`, [rowId, batchId]);
    const previous = result.rows[0];
    if (!previous) throw new HttpError(404, "CUTOVER_ROW_NOT_FOUND", "Fiche de reprise introuvable dans ce dossier.");
    const domains = await allowedDomains(tx, batchId, access);
    if (domains !== null && !domains.includes(previous.domain)) throw new HttpError(404, "CUTOVER_ROW_NOT_FOUND", "Fiche de reprise introuvable dans ce dossier.");
    if (previous.version !== input.expected_version) throw new HttpError(409, "CUTOVER_STALE_ROW", "Cette fiche a été modifiée par une autre personne. Rechargez-la avant d'enregistrer.");
    const knownFields = new Set(catalogFor(previous.domain).fields.map((field) => field.key));
    for (const field of Object.keys(input.values)) if (!knownFields.has(field)) throw new HttpError(422, "CUTOVER_UNKNOWN_FIELD", "Cette fiche ne peut contenir que les champs prévus pour ce domaine.", { field });
    for (const field of catalogFor(previous.domain).fields) if (!access.isSuperadmin && field.lookup_entity && (input.values[field.key] ?? null) !== (previous.values[field.key] ?? null)) throw new HttpError(403, "CUTOVER_SUPERADMIN_MAPPING_REQUIRED", "Le SuperAdmin choisit et vérifie les fiches CERP correspondantes. Vous pouvez compléter les informations source sans modifier ces rapprochements.", { field: field.key });
    for (const field of catalogFor(previous.domain).fields) if (field.read_only && input.values[field.key] !== previous.values[field.key]) throw new HttpError(422, "CUTOVER_READ_ONLY_FIELD", "La nature et l'origine du stock proviennent de la source et ne peuvent pas être changées dans une fiche de reprise.", { field: field.key });
    if (lockedBatch.status === "VALIDATED") await invalidateValidation(tx, lockedBatch, actorId, "ROW_UPDATED");
    const changedFields = Object.keys(input.values).filter((field) => previous.values[field] !== input.values[field]);
    const updated = { ...previous, values: input.values, decision: input.decision, review_note: input.review_note, version: previous.version + 1 };
    await tx.query(`UPDATE public.data_cutover_rows SET "values"=$3::jsonb,decision=$4,review_note=$5,version=version+1,updated_by=$6,updated_at=now() WHERE id=$1::uuid AND batch_id=$2::uuid`, [rowId, batchId, JSON.stringify(input.values), input.decision, input.review_note, actorId]);
    const batch = await tx.query<{ version: number }>("UPDATE public.data_cutover_batches SET status='DRAFT',version=version+1,preview_hash=NULL,preview_payload=NULL,validation='{}'::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING version", [batchId]);
    await audit(tx, batchId, rowId, actorId, "PREPARATION_ROW_UPDATED", { changed_fields: changedFields, decision_before: previous.decision, decision_after: input.decision, before_hash: hashCutover(previous.values), after_hash: hashCutover(input.values), business_writes: false });
    const units = await listUnits(tx);
    const row = inspectCutoverRow(updated, { allowedUnits: units.map((unit) => unit.code) });
    await verifyReferenceTargets(tx, [row]);
    return { row, batch_version: batch.rows[0]!.version };
  }, async (tx) => {
    const domains = await allowedDomains(tx, batchId, access);
    if (domains !== null) {
      const row = await tx.query<{ domain: CutoverDomain }>("SELECT domain FROM public.data_cutover_rows WHERE id=$1::uuid AND batch_id=$2::uuid", [rowId, batchId]);
      if (!row.rows[0] || !domains.includes(row.rows[0].domain)) throw new HttpError(404, "CUTOVER_ROW_NOT_FOUND", "Fiche de reprise introuvable dans ce dossier.");
    }
  });
}

/**
 * The normal customer-order launch creates an OF for every shortage.  A
 * resumed physical cohort must instead receive its delivery target first, so
 * the qualified WIP writer remains the sole creator of its OF.
 */
export async function repoPrepareCutoverWipDeliveryTarget(
  batchId: string,
  rowId: string,
  input: { expected_version: number; commande_ligne_id: string },
  actorId: number,
  key: string,
) {
  if (!await repoIsCutoverApplicationInstalled()) {
    throw new HttpError(503, "CUTOVER_APPLICATION_NOT_INSTALLED", "La reprise WIP nécessite les composants de reprise installés. Aucune affaire de livraison n'a été créée.");
  }
  return command(actorId, `wip-delivery-target:${batchId}:${rowId}`, key, input, async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    const result = await tx.query<StoredRow>(
      `SELECT id::text,batch_id::text,domain,legacy_key,source_id,sheet,row_number,source_values,"values",source_issues,source_notes,decision,review_note,version
         FROM public.data_cutover_rows WHERE id=$1::uuid AND batch_id=$2::uuid FOR UPDATE`,
      [rowId, batchId],
    );
    const stored = result.rows[0];
    if (!stored || stored.domain !== "WIP") throw new HttpError(404, "CUTOVER_WIP_ROW_NOT_FOUND", "La fiche d'encours demandée est introuvable dans ce dossier.");
    if (stored.version !== input.expected_version) throw new HttpError(409, "CUTOVER_STALE_ROW", "Cette fiche a été modifiée par une autre personne. Rechargez-la avant de préparer l'affaire.");
    if (stored.decision !== "INCLUDE") throw new HttpError(409, "CUTOVER_WIP_ROW_NOT_SELECTED", "Sélectionner cette fiche d'encours dans le lot avant de préparer son affaire de livraison.");
    if (stored.values.resumeMode !== "NATIVE_RESUME") throw new HttpError(422, "CUTOVER_WIP_RESUME_MODE_REQUIRED", "Choisir « poursuivre dans CERP » avant de préparer une affaire de livraison.");
    const orderId = typeof stored.values.affairTargetId === "string" ? stored.values.affairTargetId.trim() : "";
    const articleId = typeof stored.values.articleTargetId === "string" ? stored.values.articleTargetId.trim() : "";
    const versionId = typeof stored.values.historicalVersionId === "string" ? stored.values.historicalVersionId.trim() : "";
    if (!/^[1-9]\d{0,14}$/.test(orderId) || !articleId || !versionId) {
      throw new HttpError(422, "CUTOVER_WIP_TARGET_REQUIRED", "Rapprocher la commande, l'article et la version technique avant de préparer l'affaire de livraison.");
    }
    const existingLine = typeof stored.values.commandeLigneId === "string" ? stored.values.commandeLigneId.trim() : "";
    const existingAffair = typeof stored.values.livraisonAffaireId === "string" ? stored.values.livraisonAffaireId.trim() : "";
    if (existingAffair) throw new HttpError(409, "CUTOVER_WIP_DELIVERY_TARGET_ALREADY_PREPARED", "Cette fiche possède déjà une affaire de livraison préparée. Rechargez la fiche puis poursuivez la reprise WIP.");
    if (existingLine && existingLine !== input.commande_ligne_id) throw new HttpError(409, "CUTOVER_WIP_LINE_ALREADY_SELECTED", "Une autre ligne de commande est déjà enregistrée sur cette fiche. Rechargez-la avant de continuer.");

    const row = inspectCutoverRow(stored, { allowedUnits: (await listUnits(tx)).map((unit) => unit.code) });
    const context = await readWipPreparationContextTx(tx, row, versionId);
    if (!context.article_ready || !context.selected_version || !context.piece_technique_id || context.demand_type === "INTERNE") {
      throw new HttpError(422, "CUTOVER_WIP_CUSTOMER_ORDER_REQUIRED", "Cette préparation concerne uniquement une commande client et un article fabriqué correctement rapprochés.");
    }
    if (context.resumption_blocker) throw new HttpError(409, context.resumption_blocker.code, context.resumption_blocker.message);
    const chosenLine = context.demand_lines.find((line) => line.id === input.commande_ligne_id);
    if (!chosenLine) throw new HttpError(422, "CUTOVER_WIP_LINE_NOT_MATCHED", "Choisir une ligne de cette commande correspondant à l'article et à la version de l'encours.");
    // This performs the cohort/phase/evidence checks now, before creating any
    // native affair. It writes no historical operation or pointage.
    buildConfirmedWipCheckpoints(row, context.phases);
    const planReference = typeof row.values.planReference === "string" ? row.values.planReference.trim() : "";
    const revision = typeof row.values.technicalRevision === "string" ? row.values.technicalRevision.trim() : "";
    const noRevision = row.values.withoutRevision === true;
    if (!planReference || planReference !== context.selected_version.plan_reference ||
      (noRevision ? Boolean(context.selected_version.indice) || Boolean(revision) : !revision || revision !== context.selected_version.indice)) {
      throw new HttpError(422, "CUTOVER_WIP_REVISION_MISMATCH", "Le plan et son indice confirmés doivent correspondre à la version publiée utilisée par cet encours.");
    }
    const rowUnit = typeof row.values.unit === "string" ? canonicalizeStockUnitCode(row.values.unit) : null;
    if (!rowUnit || rowUnit !== context.unit) {
      throw new HttpError(422, "CUTOVER_WIP_UNIT_MISMATCH", "La cohorte doit utiliser l'unité de l'article CERP. Aucune conversion automatique n'est effectuée.");
    }
    const quantity = Number(String(row.values.quantityRemaining ?? "").replace(",", "."));
    const target = await createCutoverDeliveryTargetTx(tx, {
      commandeId: orderId,
      commandeLigneId: input.commande_ligne_id,
      articleId,
      pieceTechniqueVersionId: versionId,
      quantity,
    });
    const values = { ...stored.values, commandeLigneId: target.commande_ligne_id, livraisonAffaireId: target.livraison_affaire_id };
    await tx.query(`UPDATE public.data_cutover_rows SET "values"=$3::jsonb,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1::uuid AND batch_id=$2::uuid`, [rowId, batchId, JSON.stringify(values), actorId]);
    if (batch.status === "VALIDATED") await invalidateValidation(tx, batch, actorId, "WIP_DELIVERY_TARGET_PREPARED");
    const updatedBatch = await tx.query<{ version: number }>(`UPDATE public.data_cutover_batches SET status='DRAFT',version=version+1,preview_hash=NULL,preview_payload=NULL,validation='{}'::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING version`, [batchId]);
    await audit(tx, batchId, rowId, actorId, "WIP_DELIVERY_TARGET_PREPARED", {
      commande_id: orderId, commande_ligne_id: target.commande_ligne_id, livraison_affaire_id: target.livraison_affaire_id,
      affaire_reference: target.affaire_reference, quantity: target.quantity, unallocated_quantity_after: target.unallocated_quantity_after,
      creates_of: false, creates_stock_movement: false, creates_delivery: false, creates_financial_document: false, external_effects: false,
    });
    const updated = inspectCutoverRow({ ...stored, values, version: stored.version + 1 }, { allowedUnits: (await listUnits(tx)).map((unit) => unit.code) });
    await verifyReferenceTargets(tx, [updated]);
    return { row: updated, batch_version: updatedBatch.rows[0]!.version, target };
  });
}

export async function repoGetContributorDomains(userId: number): Promise<CutoverDomain[]> {
  return transaction(async (tx) => (await tx.query<{ domain: CutoverDomain }>("SELECT DISTINCT domain FROM public.data_cutover_contributors WHERE user_id=$1 ORDER BY domain", [userId])).rows.map((row) => row.domain));
}
export async function repoGetCutoverContributors(batchId: string) {
  return transaction(async (tx) => {
    await getBatch(tx, batchId);
    const result = await tx.query<{ user_id: number; username: string; domains: CutoverDomain[] }>("SELECT c.user_id,u.username,array_agg(c.domain ORDER BY c.domain) AS domains FROM public.data_cutover_contributors c JOIN public.users u ON u.id=c.user_id WHERE c.batch_id=$1::uuid GROUP BY c.user_id,u.username ORDER BY u.username,c.user_id", [batchId]);
    return { items: result.rows };
  });
}
export async function repoAssignCutoverContributor(batchId: string, input: { user_id: number; domains: CutoverDomain[] }, actorId: number, key: string) {
  return command(actorId, `contributors:${batchId}:${input.user_id}`, key, input, async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    const user = await tx.query<{ id: number }>("SELECT id FROM public.users WHERE id=$1 AND status='Active' FOR KEY SHARE", [input.user_id]);
    if (!user.rows.length) throw new HttpError(409, "CUTOVER_CONTRIBUTOR_NOT_FOUND", "Le compte sélectionné n'existe pas ou n'est pas actif.");
    const current = await tx.query<{ domain: CutoverDomain }>("SELECT domain FROM public.data_cutover_contributors WHERE batch_id=$1::uuid AND user_id=$2 ORDER BY domain", [batchId, input.user_id]);
    const currentDomains = current.rows.map((row) => row.domain);
    const requestedDomains = [...input.domains].sort();
    const changed = currentDomains.length !== requestedDomains.length || currentDomains.some((domain, index) => domain !== requestedDomains[index]);
    if (batch.status === "VALIDATED" && changed) {
      await invalidateValidation(tx, batch, actorId, "CONTRIBUTORS_CHANGED");
      await tx.query("UPDATE public.data_cutover_batches SET status='DRAFT',version=version+1,preview_hash=NULL,preview_payload=NULL,validation='{}'::jsonb,updated_at=now() WHERE id=$1::uuid", [batchId]);
    }
    if (!changed) return { user_id: input.user_id, domains: input.domains };
    await tx.query("DELETE FROM public.data_cutover_contributors WHERE batch_id=$1::uuid AND user_id=$2", [batchId, input.user_id]);
    for (const domain of input.domains) await tx.query("INSERT INTO public.data_cutover_contributors(batch_id,user_id,domain,assigned_by) VALUES($1::uuid,$2,$3,$4)", [batchId, input.user_id, domain, actorId]);
    await audit(tx, batchId, null, actorId, "PREPARATION_CONTRIBUTOR_ASSIGNED", { contributor_user_id: input.user_id, domains: input.domains });
    return { user_id: input.user_id, domains: input.domains };
  });
}

function makePreview(batch: StoredBatch, rows: CutoverRow[]): CutoverPreview {
  const selected = rows.filter((row) => row.decision === "INCLUDE");
  const blockers: CutoverPreview["blockers"] = [];
  if (!selected.length) blockers.push({ code: "CUTOVER_EMPTY_SCOPE", message: "Choisir au moins une fiche à reprendre. Les fiches non décidées restent hors de ce lot." });
  if (!batch.cutoff_at) blockers.push({ code: "CUTOVER_CUTOFF_REQUIRED", message: "Fixer la date et l'heure d'arrêt du périmètre avant sa validation." });
  for (const row of selected) for (const issue of row.issues) blockers.push({ ...issue, row_id: row.id });
  blockers.push(...duplicateCutoverTargets(rows));
  const domains = [...new Set(selected.map((row) => row.domain))].sort();
  return { preview_hash: hashCutover({ schema_version: 1, batch_id: batch.id, version: batch.version, sources: batch.sources, cutoff_at: batch.cutoff_at, selected: selected.map((row) => ({ id: row.id, version: row.version, domain: row.domain, legacy_key: row.legacy_key, values: row.values, review_note: row.review_note })), decisions: rows.map((row) => [row.id, row.version, row.decision]) }), batch_version: batch.version, ready: blockers.length === 0, summary: summarizeCutover(rows), blockers, reconciliation: domains.map((domain) => ({ domain, selected_rows: selected.filter((row) => row.domain === domain).length, ready_rows: selected.filter((row) => row.domain === domain && row.status === "READY").length })), required_checklist: requiredChecklist(rows), posting_available: false };
}

export async function repoPreviewCutover(batchId: string, input: { expected_version: number; cutoff_at?: string }, actorId: number, key: string) {
  return command(actorId, `preview:${batchId}`, key, input, async (tx) => {
    let batch = await getBatch(tx, batchId, true);
    assertVersion(batch, input.expected_version);
    const oldCutoff = batch.cutoff_at ? new Date(batch.cutoff_at).toISOString() : null;
    if (input.cutoff_at && new Date(input.cutoff_at).toISOString() !== oldCutoff) {
      await tx.query("UPDATE public.data_cutover_batches SET cutoff_at=$2::timestamptz,version=version+1,status='DRAFT',validation='{}'::jsonb,updated_at=now() WHERE id=$1::uuid", [batchId, input.cutoff_at]);
      batch = await getBatch(tx, batchId);
    }
    const rows = await getRows(tx, batchId);
    const preview = makePreview(batch, rows);
    await tx.query("UPDATE public.data_cutover_batches SET preview_hash=$2,preview_payload=$3::jsonb WHERE id=$1::uuid", [batchId, preview.preview_hash, JSON.stringify(preview)]);
    await audit(tx, batchId, null, actorId, "PREPARATION_PREVIEWED", { preview_hash: preview.preview_hash, selected_rows: preview.summary.included, blocker_count: preview.blockers.length, business_writes: false });
    return preview;
  });
}

export async function repoValidateCutover(batchId: string, input: ValidateCutover, actorId: number, key: string) {
  return command(actorId, `validate:${batchId}`, key, input, async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    assertVersion(batch, input.expected_version);
    const rows = await getRows(tx, batchId);
    const preview = makePreview(batch, rows);
    if (preview.preview_hash !== input.expected_preview_hash || batch.preview_hash !== input.expected_preview_hash) throw new HttpError(409, "CUTOVER_STALE_PREVIEW", "Le contrôle n'est plus à jour. Relancer le contrôle avant de valider.");
    if (!preview.ready) throw new HttpError(409, "CUTOVER_PREPARATION_BLOCKED", "Des informations indispensables restent à compléter dans les fiches retenues.");
    for (const check of preview.required_checklist) if (input.checklist[check as keyof ValidateCutover["checklist"]] !== true) throw new HttpError(409, "CUTOVER_CHECKLIST_INCOMPLETE", "Confirmer tous les contrôles applicables au périmètre retenu.");
    // One lock serializes signoffs, so a reference cannot be signed in two active lots.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["cutover:scope-validation"]);
    const conflicts = await tx.query<{ legacy_key: string }>(`SELECT selected.legacy_key FROM public.data_cutover_rows selected
      JOIN public.data_cutover_rows other ON other.domain=selected.domain AND other.legacy_key=selected.legacy_key AND other.batch_id<>selected.batch_id AND other.decision='INCLUDE'
      JOIN public.data_cutover_batches b ON b.id=other.batch_id AND b.status='VALIDATED'
      WHERE selected.batch_id=$1::uuid AND selected.decision='INCLUDE' AND selected.domain NOT IN ('CUSTOMER','SUPPLIER','ARTICLE','TECHNICAL_PIECE','METROLOGY') LIMIT 1`, [batchId]);
    if (conflicts.rows.length) throw new HttpError(409, "CUTOVER_OVERLAPPING_SCOPE", "Une référence sélectionnée appartient déjà à un autre lot validé. Vérifier le périmètre avant de continuer.");
    await tx.query("UPDATE public.data_cutover_batches SET status='VALIDATED',version=version+1,validation=$2::jsonb,updated_at=now() WHERE id=$1::uuid", [batchId, JSON.stringify({ ...input, actor_user_id: actorId, validated_at: new Date().toISOString(), scope: "PREPARATION_ONLY", business_writes: false })]);
    await audit(tx, batchId, null, actorId, "PREPARATION_VALIDATED", { preview_hash: preview.preview_hash, selected_rows: preview.summary.included, checklist: input.checklist, business_writes: false });
    return { batch: publicBatch(await getBatch(tx, batchId), rows) };
  });
}

export async function repoExportCutover(batchId: string) {
  return transaction(async (tx) => {
    const batch = await getBatch(tx, batchId);
    const rows = await getRows(tx, batchId);
    const { preview_payload: _preview, ...evidence } = batch;
    return { schema_version: 1, purpose: "PREPARATION_ONLY", posting_available: false, exported_at: new Date().toISOString(), batch: { ...evidence, summary: summarizeCutover(rows) }, rows };
  });
}

export async function repoIsCutoverInstalled(): Promise<boolean> {
  const result = await pool.query<{ installed: boolean }>("SELECT to_regclass('public.data_cutover_batches') IS NOT NULL AND to_regclass('public.financial_cutover_gate') IS NOT NULL AND to_regclass('public.financial_cutover_events') IS NOT NULL AS installed");
  return result.rows[0]?.installed === true;
}
export async function repoIsCutoverApplicationInstalled(): Promise<boolean> {
  const result = await pool.query<{ installed: boolean }>("SELECT to_regclass('public.data_cutover_application_runs') IS NOT NULL AND to_regclass('public.data_cutover_application_crosswalk') IS NOT NULL AND to_regclass('public.data_cutover_application_order_groups') IS NOT NULL AND to_regclass('public.data_cutover_opening_states') IS NOT NULL AND to_regclass('public.data_cutover_evidence_links') IS NOT NULL AND to_regclass('public.data_cutover_wip_resumptions') IS NOT NULL AND to_regclass('public.data_cutover_wip_operation_checkpoints') IS NOT NULL AND to_regclass('public.data_cutover_wip_material_checkpoints') IS NOT NULL AND to_regclass('public.data_cutover_wip_material_checkpoint_lines') IS NOT NULL AND to_regclass('public.data_cutover_wip_material_opening_bindings') IS NOT NULL AND to_regclass('public.financial_cutover_gate') IS NOT NULL AND to_regclass('public.financial_cutover_events') IS NOT NULL AS installed");
  return result.rows[0]?.installed === true;
}

/** Shares the application transaction; authorization is enforced by its router. */
export async function loadApplicationPreparationTx(tx: PoolClient, id: string, expectedVersion: number) {
  const batch = await getBatch(tx, id, true);
  assertVersion(batch, expectedVersion);
  if (batch.status !== "VALIDATED") throw new HttpError(409, "CUTOVER_APPLICATION_NOT_VALIDATED", "Contrôler et valider la préparation avant de charger le lot.");
  const rows = await getRows(tx, id, { includedOnly: true });
  return { batch, rows };
}

/** IDs explicitly chosen in the native lookup are resolved without equating legacy codes to IDs. */
export async function resolveApplicationExplicitTargetsTx(tx: PoolClient, rows: CutoverRow[]) {
  const targets: Array<{ alias: string; id: string; reference: string | null; type: string }> = [];
  for (const entity of Object.keys(lookupQueries) as CutoverLookupEntity[]) {
    const ids = [...new Set(rows.flatMap((row) => catalogFor(row.domain).fields.filter((field) => field.lookup_entity === entity).flatMap((field) => typeof row.values[field.key] === "string" && row.values[field.key] ? [String(row.values[field.key])] : [])))];
    if (!ids.length) continue;
    if (entity === "NATIVE_ORDER") {
      const orders = await tx.query<{ id: string; reference: string; order_type: string }>("SELECT id::text AS id,numero AS reference,order_type FROM public.commande_client WHERE id::text=ANY($1::text[])", [ids]);
      for (const order of orders.rows) targets.push({ alias: `${entity}:${order.id}`, id: order.id, reference: order.reference, type: order.order_type === "INTERNE" ? "BESOIN_INTERNE" : "COMMANDE_CLIENT" });
      continue;
    }
    const found = await tx.query<{ id: string; code: string | null }>(`SELECT id,code FROM (${lookupQueries[entity]}) lookup WHERE id=ANY($1::text[])`, [ids]);
    for (const target of found.rows) targets.push({ alias: `${entity}:${target.id}`, id: target.id, reference: target.code, type: entity });
  }
  return targets;
}

export async function repoListCutoverEvidence(batchId: string) {
  return transaction(async (tx) => { await getBatch(tx, batchId); return { items: await listEvidenceTx(tx, batchId) }; });
}
export async function repoListCutoverOpenings(batchId: string) {
  return transaction(async (tx) => { await getBatch(tx, batchId); return { items: await listCutoverOpeningStatesTx(tx, batchId) }; });
}
export async function repoLinkCutoverEvidence(batchId: string, rowId: string, input: { expected_version: number; field_key: string; ged_document_id: string }, actorId: number, key: string) {
  return command(actorId, `evidence:${batchId}:${rowId}`, key, input, async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    assertVersion(batch, input.expected_version);
    const snapshot = await linkCutoverEvidenceTx(tx, { batchId, rowId, fieldKey: input.field_key, gedDocumentId: input.ged_document_id, actorId });
    if (batch.status === "VALIDATED") await invalidateValidation(tx, batch, actorId, "EVIDENCE_LINKED");
    const updated = await tx.query<{ version: number }>("UPDATE public.data_cutover_batches SET status='DRAFT',version=version+1,preview_hash=NULL,preview_payload=NULL,validation='{}'::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING version", [batchId]);
    await audit(tx, batchId, rowId, actorId, "PREPARATION_EVIDENCE_LINKED", { field_key: input.field_key, ged_document_id: input.ged_document_id, snapshot_hash: hashCutover(snapshot), business_writes: false });
    return { snapshot, batch_version: updated.rows[0].version };
  });
}
