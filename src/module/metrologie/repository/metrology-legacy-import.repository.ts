import { HttpError } from "../../../utils/httpError";
import { db, insertAuditLog, insertMetrologyEvent, withTransaction, type MetrologyActor } from "./metrology-shared.repository";
import crypto from "node:crypto";

export type LegacyObservation = {
  id: string; raw_row_id: string; equipement_id: string; observed_on: string | null;
  observed_date_raw: string | null; legacy_visa_text: string | null;
  legacy_verdict_text: string | null; raw_values: Record<string, unknown>;
  imported_at: string; imported_by: number | null;
  batch_id: string; source_file_id: string; sheet_name: string; source_coordinate: string;
};

/** Historical observations are deliberately not executions: no CERP user,
 * verdict or tolerance is inferred from a spreadsheet row. */
export async function repoListLegacyObservations(params: { equipmentId: string; page: number; pageSize: number }): Promise<{ items: LegacyObservation[]; total: number }> {
  const offset = (params.page - 1) * params.pageSize;
  const result = await db().query<LegacyObservation & { total: string }>(`
    SELECT o.id::text, o.raw_row_id::text, o.equipement_id::text, o.observed_on::text,
           observed_date_raw, legacy_visa_text, legacy_verdict_text, raw_values,
           imported_at::text, imported_by, b.id::text AS batch_id,
           r.source_file_id::text, r.sheet_name, r.source_coordinate,
           count(*) OVER() AS total
      FROM public.metrologie_legacy_observations o
      JOIN public.metrologie_import_raw_rows r ON r.id = o.raw_row_id
      JOIN public.metrologie_import_source_files f ON f.id = r.source_file_id
      JOIN public.metrologie_import_batches b ON b.id = f.batch_id
     WHERE o.equipement_id = $1::uuid
     ORDER BY observed_on DESC NULLS LAST, imported_at DESC, o.id DESC
     LIMIT $2 OFFSET $3`, [params.equipmentId, params.pageSize, offset]);
  let total = Number(result.rows[0]?.total ?? 0);
  if (params.page > 1 && result.rows.length === 0) {
    const count = await db().query<{ total: string }>("SELECT count(*)::text AS total FROM public.metrologie_legacy_observations WHERE equipement_id=$1::uuid", [params.equipmentId]);
    total = Number(count.rows[0]?.total ?? 0);
  }
  return { items: result.rows.map(({ total: _total, ...row }) => row), total };
}

export async function repoGetLegacyImportBatch(batchId: string) {
  const result = await db().query(`
    SELECT b.id::text, b.source_set_sha256, b.parser_version, b.status, b.manifest->'summary' AS manifest,
           (b.reconciliation - 'scans') AS reconciliation, b.created_at::text, b.applied_at::text,
           COALESCE(stats.rows_total, 0)::int AS rows_total,
           COALESCE(stats.rows_ambiguous, 0)::int AS rows_ambiguous,
           COALESCE(stats.rows_imported, 0)::int AS rows_imported,
           COALESCE(files.items, '[]'::jsonb) AS source_files
      FROM public.metrologie_import_batches b
      LEFT JOIN LATERAL (SELECT count(r.id) AS rows_total,
        count(r.id) FILTER (WHERE r.disposition = 'AMBIGUOUS') AS rows_ambiguous,
        count(r.id) FILTER (WHERE r.disposition = 'IMPORTED') AS rows_imported
        FROM public.metrologie_import_source_files f JOIN public.metrologie_import_raw_rows r ON r.source_file_id = f.id WHERE f.batch_id = b.id) stats ON TRUE
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id', f.id::text, 'name', f.source_name, 'sha256', f.sha256, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'av_status', f.av_status) ORDER BY f.source_name) AS items
        FROM public.metrologie_import_source_files f WHERE f.batch_id = b.id) files ON TRUE
     WHERE b.id = $1::uuid
    `, [batchId]);
  return result.rows[0] ?? null;
}

export async function repoGetLegacyImportSourceFile(sourceFileId: string) {
  const result = await db().query<{ storage_path: string; mime_type: string | null; source_name: string; sha256: string; av_status: string }>(
    `SELECT storage_path, mime_type, source_name, sha256, av_status FROM public.metrologie_import_source_files WHERE id = $1::uuid`, [sourceFileId]
  );
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Source d'import introuvable.");
  return result.rows[0];
}

/** Records the authorized source-evidence read before any bytes leave storage. */
export async function repoRecordLegacySourceRead(sourceFileId: string, actor: MetrologyActor) {
  await insertAuditLog(db(), actor, {
    action: "metrologie.legacy_import.source_read",
    entity_type: "metrologie_import_source_files",
    entity_id: sourceFileId,
    details: null,
  });
}

/** Read-only evidence view. Raw cells are returned only through this opaque
 * batch scope; callers cannot submit them to an import command. */
export async function repoListLegacyImportBatches(page: number, pageSize: number) {
  const result = await db().query(`SELECT b.id::text,b.status,b.parser_version,b.source_set_sha256,b.created_at::text,b.applied_at::text,count(*) OVER() total FROM public.metrologie_import_batches b ORDER BY b.created_at DESC LIMIT $1 OFFSET $2`,[pageSize,(page-1)*pageSize]);
  let total = Number(result.rows[0]?.total ?? 0);
  if (page > 1 && result.rows.length === 0) {
    const count = await db().query<{ total: string }>("SELECT count(*)::text AS total FROM public.metrologie_import_batches");
    total = Number(count.rows[0]?.total ?? 0);
  }
  return { items: result.rows.map(({ total: _total, ...row }) => row), total };
}
export async function repoListLegacyImportRows(batchId: string, page: number, pageSize: number, filters: { disposition?: string; source_file_id?: string; kind?: string }) {
  const where=["f.batch_id=$1::uuid"], values: unknown[]=[batchId]; if(filters.disposition){values.push(filters.disposition);where.push(`r.disposition=$${values.length}`)} if(filters.source_file_id){values.push(filters.source_file_id);where.push(`f.id=$${values.length}::uuid`)} if(filters.kind){values.push(filters.kind);where.push(`r.normalized->>'record_kind'=$${values.length}`)} values.push(pageSize,(page-1)*pageSize);
  const result = await db().query(`SELECT r.id::text,r.sheet_name,r.source_coordinate,r.source_equipment_key,r.raw_cells,r.normalized,r.disposition,r.diagnostic,r.target_equipment_id::text,r.created_at::text,f.id::text source_file_id,f.source_name,count(*) OVER() total FROM public.metrologie_import_raw_rows r JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id WHERE ${where.join(" AND ")} ORDER BY f.source_name,r.sheet_name,r.source_coordinate LIMIT $${values.length-1} OFFSET $${values.length}`, values);
  let total = Number(result.rows[0]?.total ?? 0);
  if (page > 1 && result.rows.length === 0) {
    const countValues = values.slice(0, values.length - 2);
    const count = await db().query(`SELECT count(*)::text total FROM public.metrologie_import_raw_rows r JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id WHERE ${where.join(" AND ")}`, countValues);
    total = Number(count.rows[0]?.total ?? 0);
  }
  return { items: result.rows.map(({ total: _total, ...row }) => row), total };
}

export async function repoResolveLegacyImportRow(params: { batchId: string; rowId: string; equipmentId: string | null; disposition: "IMPORTED" | "AMBIGUOUS" | "SKIPPED" | "CONFLICT"; reason: string; actor: MetrologyActor }) {
  return withTransaction(async (client) => {
    const row = await client.query<{ normalized: Record<string, unknown>; raw_cells: Record<string, unknown>; target_equipment_id: string | null }>(`SELECT r.normalized,r.raw_cells,r.target_equipment_id::text FROM public.metrologie_import_raw_rows r JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id WHERE r.id=$1::uuid AND f.batch_id=$2::uuid FOR UPDATE`, [params.rowId,params.batchId]);
    if (!row.rows[0]) throw new HttpError(404,"NOT_FOUND","Ligne d'import introuvable dans ce lot.");
    const n = row.rows[0].normalized;
    if (n.record_kind !== "history" && n.record_kind !== "attachment") throw new HttpError(409,"METROLOGY_IMPORT_RESOLUTION_KIND","Seul un historique ou une pièce jointe peut être affecté manuellement.");
    if (n.record_kind === "attachment" && params.disposition === "IMPORTED") {
      if (!params.equipmentId) throw new HttpError(422,"METROLOGY_IMPORT_TARGET_REQUIRED","Un équipement cible est requis.");
      const target = await client.query(`SELECT 1 FROM public.metrologie_equipements WHERE id=$1::uuid AND deleted_at IS NULL`,[params.equipmentId]);
      if (!target.rowCount) throw new HttpError(404,"METROLOGY_IMPORT_TARGET_NOT_FOUND","Équipement cible introuvable.");
    } else if (params.disposition === "IMPORTED") {
      if (!params.equipmentId) throw new HttpError(422,"METROLOGY_IMPORT_TARGET_REQUIRED","Un équipement cible est requis.");
      const target = await client.query(`SELECT 1 FROM public.metrologie_equipements WHERE id=$1::uuid AND deleted_at IS NULL`,[params.equipmentId]);
      if (!target.rowCount) throw new HttpError(404,"METROLOGY_IMPORT_TARGET_NOT_FOUND","Équipement cible introuvable.");
      const existing = await client.query<{ equipement_id: string }>(`SELECT equipement_id::text FROM public.metrologie_legacy_observations WHERE raw_row_id=$1::uuid FOR UPDATE`,[params.rowId]);
      if (existing.rows[0] && existing.rows[0].equipement_id !== params.equipmentId) throw new HttpError(409,"METROLOGY_IMPORT_OBSERVATION_IMMUTABLE","Cette observation est déjà liée à un autre équipement.");
      if (!existing.rows[0]) await client.query(`INSERT INTO public.metrologie_legacy_observations(raw_row_id,equipement_id,observed_on,observed_date_raw,legacy_visa_text,legacy_verdict_text,raw_values,imported_by) VALUES($1::uuid,$2::uuid,$3::date,$4,$5,$6,$7::jsonb,$8)`,[params.rowId,params.equipmentId,typeof n.observed_on === "string" ? n.observed_on : null,typeof n.observed_date_raw === "string" ? n.observed_date_raw : null,typeof n.legacy_visa_text === "string" ? n.legacy_visa_text : null,typeof n.legacy_verdict_text === "string" ? n.legacy_verdict_text : null,JSON.stringify(row.rows[0].raw_cells),params.actor.user_id]);
    }
    if (n.record_kind === "history") {
      const immutable = await client.query<{ equipement_id: string }>(`SELECT equipement_id::text FROM public.metrologie_legacy_observations WHERE raw_row_id=$1::uuid FOR UPDATE`, [params.rowId]);
      if (immutable.rows[0] && (params.disposition !== "IMPORTED" || immutable.rows[0].equipement_id !== params.equipmentId)) throw new HttpError(409,"METROLOGY_IMPORT_OBSERVATION_IMMUTABLE","Cette observation est déjà liée à un équipement.");
    }
    const result=await client.query(`UPDATE public.metrologie_import_raw_rows SET target_equipment_id=$2::uuid,disposition=$3,resolved_by=$4,resolved_at=now() WHERE id=$1::uuid RETURNING id::text,disposition,target_equipment_id::text`,[params.rowId,params.equipmentId,params.disposition,params.actor.user_id]);
    await insertAuditLog(client,params.actor,{action:"metrologie.legacy_import.resolve",entity_type:"metrologie_import_raw_rows",entity_id:params.rowId,details:{batch_id:params.batchId,disposition:params.disposition,equipment_id:params.equipmentId,reason:params.reason}});
    return result.rows[0];
  });
}

export type LegacyRegistryGroup = { group_id: string; group_kind: "registry-apparatus" | "folder-extra" | "reference-token"; observed_code_verbatim: string; identity_status: "exact" | "ambiguous" | "folder-only" | "legacy-dated-code" | "unresolved"; designation: string; marque?: string | null; numero_serie?: string | null; historique: Record<string, unknown>; source_sha256: string };

export async function repoPreviewLegacyRegistryGroups(groups: readonly LegacyRegistryGroup[]) {
  const items = [] as Array<{ group_id: string; action: "CREATE" | "HOLD" | "CONFLICT"; reason: string }>;
  for (const group of groups) {
    if (group.group_kind !== "registry-apparatus" || !/^[a-f0-9]{64}$/i.test(group.source_sha256) || !group.observed_code_verbatim.trim() || !group.designation.trim()) { items.push({ group_id: group.group_id, action: "HOLD", reason: "NOT_A_COMPLETE_REGISTRY_RECORD" }); continue; }
    if (group.identity_status !== "exact" && group.identity_status !== "legacy-dated-code") { items.push({ group_id: group.group_id, action: "HOLD", reason: "IDENTITY_NOT_EXACT" }); continue; }
    const existing = await db().query(`SELECT id FROM public.metrologie_equipements WHERE deleted_at IS NULL AND (code = $1 OR ($2::text IS NOT NULL AND numero_serie = $2)) LIMIT 2`, [group.observed_code_verbatim, group.numero_serie ?? null]);
    items.push(existing.rowCount === 0 ? { group_id: group.group_id, action: "CREATE", reason: "NO_EXISTING_EXACT_MATCH" } : { group_id: group.group_id, action: "CONFLICT", reason: "EXISTING_ERP_MATCH" });
  }
  return { items, creatable: items.filter((item) => item.action === "CREATE").length, held: items.filter((item) => item.action !== "CREATE").length };
}

export async function repoApplyLegacyRegistryGroup(params: { group: LegacyRegistryGroup; actor: MetrologyActor }) {
  const replay = await db().query<{ id: string; code: string }>(`SELECT id::text, code FROM public.metrologie_equipements WHERE deleted_at IS NULL AND specifications->'legacy_import'->>'group_id' = $1 AND specifications->'legacy_import'->>'source_sha256' = $2 LIMIT 1`, [params.group.group_id, params.group.source_sha256]);
  if (replay.rows[0]) return { ...replay.rows[0], etat: "DRAFT", origin: "IMPORTED_LEGACY", replay: true };
  const preview = await repoPreviewLegacyRegistryGroups([params.group]);
  if (preview.items[0]?.action !== "CREATE") throw new HttpError(409, "METROLOGY_IMPORT_GROUP_HELD", "Le groupe registre doit être revu avant import.", preview.items[0]);
  return withTransaction(async (client) => {
    const group = params.group;
    const inserted = await client.query<{ id: string }>(`INSERT INTO public.metrologie_equipements (code, designation, marque, numero_serie, statut, etat, specifications, notes, created_by, updated_by) VALUES ($1,$2,$3,$4,'INACTIF','DRAFT',$5::jsonb,$6,$7,$7) RETURNING id::text`, [group.observed_code_verbatim, group.designation, group.marque ?? null, group.numero_serie ?? null, JSON.stringify({ legacy_import: { group_id: group.group_id, source_sha256: group.source_sha256, identity_status: group.identity_status, historique: group.historique } }), "Import legacy: metadata retained verbatim; qualification required before use.", params.actor.user_id]);
    const id = inserted.rows[0]?.id;
    if (!id) throw new HttpError(500, "METROLOGY_IMPORT_CREATE_FAILED", "Création de l'équipement importé impossible.");
    const correlation = crypto.randomUUID();
    await insertMetrologyEvent(client, { equipement_id: id, entity_type: "EQUIPEMENT", entity_id: id, event_type: "EQUIPEMENT_IMPORTED_LEGACY", actor: params.actor, old_values: null, new_values: { code: group.observed_code_verbatim, origin: "IMPORTED_LEGACY", qualified: false }, correlation_id: correlation, reason: "SOURCE_BACKED_LEGACY_IMPORT" });
    await insertAuditLog(client, params.actor, { action: "metrologie.equipements.import_legacy", entity_type: "metrologie_equipements", entity_id: id, details: { group_id: group.group_id, source_sha256: group.source_sha256 } });
    return { id, code: group.observed_code_verbatim, etat: "DRAFT", origin: "IMPORTED_LEGACY" };
  });
}

/** Loads the group from an immutable staged batch; HTTP callers must never
 * supply code, source hash, or registry facts themselves. */
export async function repoApplyStagedLegacyRegistryGroup(params: { batchId: string; groupId: string; expectedSourceSetSha256: string; actor: MetrologyActor }) {
  const staged = await db().query<{ normalized: Record<string, unknown>; source_sha256: string }>(`
    SELECT r.normalized, f.sha256 AS source_sha256
      FROM public.metrologie_import_raw_rows r
      JOIN public.metrologie_import_source_files f ON f.id = r.source_file_id AND f.av_status = 'CLEAN'
      JOIN public.metrologie_import_batches b ON b.id = f.batch_id
     WHERE b.id = $1::uuid AND b.source_set_sha256 = $2
       AND r.normalized->>'group_id' = $3
     LIMIT 1`, [params.batchId, params.expectedSourceSetSha256, params.groupId]);
  const row = staged.rows[0];
  const normalized = row?.normalized;
  const evidence = normalized && typeof normalized.registry_evidence === "object" && normalized.registry_evidence !== null
    ? normalized.registry_evidence as Record<string, unknown> : {};
  const code = typeof evidence?.COCONTR === "string" ? evidence.COCONTR.trim() : "";
  const observed = typeof normalized?.observed_code_verbatim === "string" ? normalized.observed_code_verbatim.trim() : "";
  const identity = normalized?.identity_status;
  const canonical = /^[A-Z]{2,8}-[0-9]{2,6}$/.test(code);
  const literalLegacy = identity === "legacy-dated-code" && /^[A-Z]{2,8}-[0-9]{2,6}(?:[-_/][0-9A-Z]{1,12})+$/.test(code);
  if (!row || normalized?.group_kind !== "registry-apparatus" || observed !== code || (!canonical && !literalLegacy)) {
    throw new HttpError(409, "METROLOGY_IMPORT_STAGED_GROUP_INVALID", "Le groupe stagé ne prouve pas un code registre importable.");
  }
  return repoApplyLegacyRegistryGroup({ group: { group_id: params.groupId, group_kind: "registry-apparatus", observed_code_verbatim: code, identity_status: identity === "legacy-dated-code" ? "legacy-dated-code" : "exact", designation: typeof evidence.DESA1 === "string" && evidence.DESA1.trim() ? evidence.DESA1.trim() : code, marque: typeof evidence.MARQU === "string" ? evidence.MARQU : null, numero_serie: typeof evidence.NUMSERIE === "string" ? evidence.NUMSERIE : null, historique: evidence, source_sha256: row.source_sha256 }, actor: params.actor });
}

/** Applies a complete immutable batch atomically.  Client supplied registry
 * facts are never considered: every value is read back from staged rows. */
export async function repoApplyStagedLegacyBatch(params: { batchId: string; actor: MetrologyActor }) {
  return withTransaction(async (client) => {
    const batch = await client.query<{ source_set_sha256: string; status: string }>(`SELECT source_set_sha256,status FROM public.metrologie_import_batches WHERE id=$1::uuid FOR UPDATE`, [params.batchId]);
    if (!batch.rowCount) throw new HttpError(404, "NOT_FOUND", "Lot d'import introuvable.");
    if (batch.rows[0].status === "APPLIED") {
      const counts = await client.query<{ equipment_created: number; history_imported: number }>([
        "SELECT",
        "(SELECT count(*)::int FROM public.metrologie_import_raw_rows r JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id",
        "WHERE f.batch_id=$1::uuid AND r.normalized->>'record_kind'='equipment' AND r.disposition='IMPORTED') AS equipment_created,",
        "(SELECT count(*)::int FROM public.metrologie_legacy_observations o JOIN public.metrologie_import_raw_rows r ON r.id=o.raw_row_id",
        "JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id WHERE f.batch_id=$1::uuid) AS history_imported",
      ].join(" "), [params.batchId]);
      return { batch_id: params.batchId, replay: true, ...counts.rows[0] };
    }
    if (batch.rows[0].status !== "STAGED") throw new HttpError(409, "METROLOGY_IMPORT_BATCH_HELD", "Le lot n'est pas applicable.");
    const files = await client.query(`SELECT count(*) FILTER (WHERE av_status='CLEAN')::int clean, count(*)::int total FROM public.metrologie_import_source_files WHERE batch_id=$1::uuid`, [params.batchId]);
    if (!files.rows[0] || files.rows[0].clean !== files.rows[0].total || files.rows[0].total === 0) throw new HttpError(409, "METROLOGY_IMPORT_AV_REQUIRED", "Toutes les sources doivent avoir une preuve antivirus CLEAN.");
    const groups = await client.query<{ id: string; normalized: Record<string, unknown>; sha256: string }>(`SELECT r.id::text,r.normalized,f.sha256 FROM public.metrologie_import_raw_rows r JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id WHERE f.batch_id=$1::uuid AND r.normalized->>'record_kind'='equipment' ORDER BY r.normalized->>'group_id'`, [params.batchId]);
    const seen = new Set<string>();
    for (const row of groups.rows) { const n=row.normalized, e=n.registry_evidence as Record<string, unknown>, code=n.group_kind === "registry-apparatus" ? (typeof e?.COCONTR === "string" ? e.COCONTR.trim() : "") : (typeof n.observed_code_verbatim === "string" ? n.observed_code_verbatim.trim() : ""); const canonical = /^[A-Z]{2,8}-[0-9]{2,6}$/.test(code); const datedRegistry = n.group_kind === "registry-apparatus" && n.identity_status === "legacy-dated-code" && /^[A-Z]{2,8}-[0-9]{2,6}(?:[-_/][0-9A-Z]{1,12})+$/.test(code); if (!code || (n.group_kind !== "registry-apparatus" && n.group_kind !== "source-card-apparatus") || !((n.group_kind === "source-card-apparatus" && canonical) || (n.group_kind === "registry-apparatus" && (canonical || datedRegistry))) || (n.group_kind === "registry-apparatus" && n.observed_code_verbatim !== code) || seen.has(code)) throw new HttpError(409,"METROLOGY_IMPORT_STAGED_GROUP_INVALID","Le lot contient un groupe appareil non prouvé."); seen.add(code); const collision=await client.query(`SELECT 1 FROM public.metrologie_equipements WHERE deleted_at IS NULL AND code=$1 LIMIT 1`,[code]); if(collision.rowCount) throw new HttpError(409,"METROLOGY_IMPORT_COLLISION","Un équipement ERP existe déjà; aucune donnée n'a été écrasée.",{code}); }
    const ids = new Map<string,string>();
    for (const row of groups.rows) { const n=row.normalized,e=n.registry_evidence as Record<string,unknown>, fiche=(typeof n.fiche_metrologie === "object" && n.fiche_metrologie !== null ? n.fiche_metrologie : {}) as Record<string, unknown>, history=(typeof fiche.historique === "object" && fiche.historique !== null ? fiche.historique : {}) as Record<string, unknown>, code=n.group_kind === "registry-apparatus" ? (e.COCONTR as string).trim() : String(n.observed_code_verbatim).trim(), designation=typeof e.DESA1 === "string" && e.DESA1.trim() ? e.DESA1.trim() : (typeof n.designation === "string" && n.designation.trim() ? n.designation.trim() : code); const ins=await client.query<{id:string}>(`INSERT INTO public.metrologie_equipements(code,designation,marque,numero_serie,categorie_code,proprietaire_service,date_mise_en_service,etalon_reference,statut,etat,specifications,notes,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,'INACTIF','DRAFT',$9::jsonb,$10,$11,$11) RETURNING id::text`,[code,designation,typeof e.MARQU === "string" ? e.MARQU : (typeof n.marque === "string" ? n.marque : null),typeof e.NUMSERIE === "string" ? e.NUMSERIE : (typeof n.numero_serie === "string" ? n.numero_serie : null),typeof n.categorie_code === "string" ? n.categorie_code : null,typeof history.COSERVICE === "string" ? history.COSERVICE : null,typeof history.DATEENTR === "string" ? history.DATEENTR : null,typeof history.ETREF === "string" ? history.ETREF : null,JSON.stringify({legacy_import:{batch_id:params.batchId,group_id:n.group_id,source_sha256:row.sha256,identity_status:n.identity_status,source_facts:n.source_facts ?? {},registry_evidence:e},fiche_metrologie:{version:1,profile_code:fiche.profile_code ?? null,historique:history,control_schema:fiche.control_schema ?? null}}),"Import legacy: source evidence retained; qualification required before use.",params.actor.user_id]); ids.set(String(n.group_id),ins.rows[0].id); await client.query(`UPDATE public.metrologie_import_raw_rows SET target_equipment_id=$2::uuid,disposition='IMPORTED',resolved_by=$3,resolved_at=now() WHERE id=$1::uuid`,[row.id,ins.rows[0].id,params.actor.user_id]); await insertMetrologyEvent(client,{equipement_id:ins.rows[0].id,entity_type:"EQUIPEMENT",entity_id:ins.rows[0].id,event_type:"EQUIPEMENT_IMPORTED_LEGACY",actor:params.actor,old_values:null,new_values:{code,origin:"IMPORTED_LEGACY",qualified:false},correlation_id:crypto.randomUUID(),reason:"SOURCE_BACKED_LEGACY_IMPORT"}); }
    const histories = await client.query<{ id: string; normalized: Record<string, unknown>; raw_cells: Record<string, unknown> }>(`SELECT r.id::text,r.normalized,r.raw_cells FROM public.metrologie_import_raw_rows r JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id WHERE f.batch_id=$1::uuid AND r.normalized->>'record_kind'='history'`, [params.batchId]);
    let historyImported = 0;
    for (const row of histories.rows) { const groupId = row.normalized.equipment_group_id; const equipmentId = typeof groupId === "string" ? ids.get(groupId) : undefined; if (!equipmentId) { await client.query(`UPDATE public.metrologie_import_raw_rows SET disposition='AMBIGUOUS' WHERE id=$1::uuid`,[row.id]); continue; } const observation=await client.query(`INSERT INTO public.metrologie_legacy_observations(raw_row_id,equipement_id,observed_on,observed_date_raw,legacy_visa_text,legacy_verdict_text,raw_values,imported_by) VALUES($1::uuid,$2::uuid,$3::date,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (raw_row_id) DO NOTHING RETURNING id`, [row.id,equipmentId,typeof row.normalized.observed_on === "string" ? row.normalized.observed_on : null,typeof row.normalized.observed_date_raw === "string" ? row.normalized.observed_date_raw : null,typeof row.normalized.legacy_visa_text === "string" ? row.normalized.legacy_visa_text : null,typeof row.normalized.legacy_verdict_text === "string" ? row.normalized.legacy_verdict_text : null,JSON.stringify(row.raw_cells),params.actor.user_id]); await client.query(`UPDATE public.metrologie_import_raw_rows SET target_equipment_id=$2::uuid,disposition='IMPORTED',resolved_by=$3,resolved_at=now() WHERE id=$1::uuid`,[row.id,equipmentId,params.actor.user_id]); if(observation.rowCount) historyImported++; }
    const linkedEvidence = await client.query<{ id: string; normalized: Record<string, unknown> }>(`SELECT r.id::text,r.normalized FROM public.metrologie_import_raw_rows r JOIN public.metrologie_import_source_files f ON f.id=r.source_file_id WHERE f.batch_id=$1::uuid AND r.normalized->>'record_kind' IN ('attachment','source-row')`, [params.batchId]);
    for (const row of linkedEvidence.rows) { const groupId = row.normalized.equipment_group_id; const equipmentId = typeof groupId === "string" ? ids.get(groupId) : undefined; const sourceRow = row.normalized.record_kind === "source-row"; const legacyReview = sourceRow && row.normalized.legacy_registry_review === true; if (!equipmentId) { await client.query(`UPDATE public.metrologie_import_raw_rows SET disposition=$2 WHERE id=$1::uuid`,[row.id,legacyReview ? "AMBIGUOUS" : sourceRow ? "SKIPPED" : "AMBIGUOUS"]); continue; } await client.query(`UPDATE public.metrologie_import_raw_rows SET target_equipment_id=$2::uuid,disposition=$3,resolved_by=$4,resolved_at=now() WHERE id=$1::uuid`,[row.id,equipmentId,legacyReview ? "AMBIGUOUS" : sourceRow ? "SKIPPED" : "IMPORTED",params.actor.user_id]); }
    await client.query(`UPDATE public.metrologie_import_batches SET status='APPLIED',applied_at=now(),applied_by=$2 WHERE id=$1::uuid`,[params.batchId,params.actor.user_id]);
    await insertAuditLog(client,params.actor,{action:"metrologie.legacy_import.apply",entity_type:"metrologie_import_batches",entity_id:params.batchId,details:{source_set_sha256:batch.rows[0].source_set_sha256,equipment_created:ids.size}});
    return { batch_id:params.batchId,replay:false,equipment_created:ids.size,history_imported:historyImported };
  });
}
