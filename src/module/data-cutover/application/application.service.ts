import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { catalogFor } from "../domain/cutover-catalog";
import { hashCutover } from "../domain/cutover-validation";
import { loadApplicationPreparationTx, resolveApplicationExplicitTargetsTx } from "../repository/data-cutover.repository";
import type { CutoverDomain, CutoverIssue, CutoverRow } from "../types/data-cutover.types";
import type { ApplicationApplyInput } from "../validators/data-cutover.validators";
import type { ApplicationAdapter, ApplicationContext, ApplicationOperation, ApplicationPreview, ApplicationReceipt, ApplicationTarget, ResolvedApplicationTarget } from "./application.types";

const priority: CutoverDomain[] = ["CUSTOMER", "SUPPLIER", "TECHNICAL_PIECE", "ARTICLE", "METROLOGY", "OPENING_STOCK", "SALES_ORDER", "INTERNAL_DEMAND", "SUPPLIER_ORDER", "WIP", "LEGACY_DELIVERY", "LEGACY_RECEIPT", "OPENING_RECEIVABLE", "OPENING_PAYABLE", "LEGACY_PROFORMA"];
const MAX_APPLICATION_ROWS = 200;
type Crosswalk = { domain: CutoverDomain; legacy_key: string; source_reference: string; payload_hash: string; target_type: string; target_id: string; target_reference: string | null };
export const applicationRowHash = (row: CutoverRow) => hashCutover({ domain: row.domain, legacy_key: row.legacy_key, source_id: row.source_id, source_values: row.source_values, values: row.values });
export function applicationSourceReference(row: CutoverRow): string {
  const keys: Partial<Record<CutoverDomain, string>> = { CUSTOMER: "customerCode", SUPPLIER: "supplierCode", ARTICLE: "articleReference", TECHNICAL_PIECE: "articleReference", METROLOGY: "equipmentReference" };
  const key = keys[row.domain];
  return key && typeof row.values[key] === "string" ? String(row.values[key]).trim() : row.legacy_key;
}
export function applicationTargetLink(target: { type: string; id: string; reference: string | null }, batchId?: string): ApplicationTarget {
  const routes: Record<string, string> = { CUSTOMER: "/clients", SUPPLIER: "/fournisseurs", ARTICLE: "/stock/articles", TECHNICAL_PIECE: "/pieces-techniques", SALES_ORDER: "/commandes", COMMANDE_CLIENT: "/commandes", SUPPLIER_ORDER: "/commandes-fournisseurs", COMMANDE_FOURNISSEUR: "/commandes-fournisseurs", INTERNAL_DEMAND: "/commandes", BESOIN_INTERNE: "/commandes", STOCK_LOT: "/stock/lots", STOCK_MOVEMENT: "/stock/mouvements", METROLOGY: "/metrologie/equipements" };
  const root = routes[target.type];
  return { ...target, url: root ? `${root}/${encodeURIComponent(target.id)}` : `/administration/importation${batchId ? `?batch=${encodeURIComponent(batchId)}` : ""}` };
}
function errorIssue(error: unknown) {
  return error instanceof HttpError ? { field: null, code: error.code, message: error.message } : { field: null, code: "CUTOVER_OPERATION_UNAVAILABLE", message: "Le contrôle de cette opération est indisponible. Aucune donnée métier n'a été chargée." };
}
async function transaction<T>(db: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try { await tx.query("BEGIN"); const result = await fn(tx); await tx.query("COMMIT"); return result; }
  catch (error) { await tx.query("ROLLBACK").catch(() => undefined); if ((error as { code?: string }).code === "42P01") throw new HttpError(503, "CUTOVER_APPLICATION_NOT_INSTALLED", "Le chargement de reprise n'est pas encore installé. La préparation est conservée."); throw error; }
  finally { tx.release(); }
}
function attachTarget(map: Map<string, ResolvedApplicationTarget>, ambiguous: Set<string>, alias: string, target: ResolvedApplicationTarget) {
  if (ambiguous.has(alias)) return;
  const previous = map.get(alias);
  if (previous && (previous.id !== target.id || previous.type !== target.type)) { map.delete(alias); ambiguous.add(alias); }
  else map.set(alias, target);
}
async function loadTargets(tx: PoolClient, sourceSystem: string) {
  const result = await tx.query<Crosswalk>("SELECT domain,legacy_key,source_reference,payload_hash,target_type,target_id,target_reference FROM public.data_cutover_application_crosswalk WHERE source_system=$1", [sourceSystem]);
  const targets = new Map<string, ResolvedApplicationTarget>();
  const ambiguous = new Set<string>();
  const byKey = new Map<string, Crosswalk>();
  for (const row of result.rows) {
    const target = { id: row.target_id, reference: row.target_reference, type: row.target_type };
    byKey.set(`${row.domain}:${row.legacy_key}`, row);
    attachTarget(targets, ambiguous, `${row.domain}:${row.legacy_key}`, target);
    attachTarget(targets, ambiguous, `${row.domain}:${row.source_reference}`, target);
  }
  return { targets, ambiguous, byKey };
}
async function inspectEvidence(tx: PoolClient, batchId: string) {
  const exists = await tx.query<{ installed: boolean }>("SELECT to_regclass('public.data_cutover_evidence_links') IS NOT NULL AS installed");
  if (!exists.rows[0]?.installed) return { snapshot: [], blockers: [] as Array<CutoverIssue & { row_id?: string }> };
  const result = await tx.query<{ row_id: string; field_key: string; snapshot: unknown; readable: boolean }>(`SELECT link.row_id::text,link.field_key,link.snapshot,(document.id IS NOT NULL AND document.archived_at IS NULL AND version.id IS NOT NULL AND blob.sha256=link.snapshot->>'sha256') AS readable FROM public.data_cutover_evidence_links link LEFT JOIN public.ged_documents document ON document.id=link.ged_document_id LEFT JOIN public.ged_document_versions version ON version.id::text=link.snapshot->>'current_version_id' AND version.document_id=document.id LEFT JOIN public.ged_blobs blob ON blob.id=version.blob_id WHERE link.batch_id=$1::uuid ORDER BY link.id`, [batchId]);
  return { snapshot: result.rows.map((row) => [row.row_id, row.field_key, row.snapshot]), blockers: result.rows.filter((row) => !row.readable).map((row) => ({ row_id: row.row_id, field: row.field_key, code: "CUTOVER_EVIDENCE_UNAVAILABLE", message: "Le justificatif GED figé n'est plus disponible dans sa version validée. Vérifier le document avant le chargement." })) };
}
function groupsFor(rows: CutoverRow[], adapters: ApplicationAdapter[], targets: ReadonlyMap<string, ResolvedApplicationTarget>) {
  const groups = new Map<string, { adapter: ApplicationAdapter | undefined; rows: CutoverRow[] }>();
  for (const row of rows) {
    const adapter = adapters.find((entry) => entry.domains.includes(row.domain));
    const group = adapter ? adapter.groupKey(row, targets) : row.id;
    const key = hashCutover({ domain: row.domain, kind: adapter?.kind, group });
    const existing = groups.get(key);
    if (existing) existing.rows.push(row); else groups.set(key, { adapter, rows: [row] });
  }
  return [...groups.entries()].sort((a, b) => priority.indexOf(a[1].rows[0].domain) - priority.indexOf(b[1].rows[0].domain) || a[0].localeCompare(b[0]));
}
function plannedTarget(row: CutoverRow, type: string): ResolvedApplicationTarget {
  const digest = hashCutover({ domain: row.domain, key: row.legacy_key });
  // UUIDs satisfy native reference DTOs, but are never sent to a native writer.
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return { id: type === "CUSTOMER" ? "000" : id, type, reference: applicationSourceReference(row), planned: true };
}
type ApplicationAuditWriter = (tx: PoolClient, receipt: ApplicationReceipt) => Promise<void>;
const writeApplicationAudit: ApplicationAuditWriter = async (tx, receipt) => {
  await repoInsertAuditLog({ tx, user_id: receipt.applied_by, ip: null, user_agent: null, device_type: null, os: null, browser: null, body: { event_type: "ACTION", action: "CUTOVER_APPLICATION_COMMITTED", page_key: "administration-reprise", entity_type: "cutover_application", entity_id: receipt.id, path: "/administration/importation", details: { batch_id: receipt.batch_id, operation_count: receipt.operations.length, business_writes: receipt.business_writes, external_effects: false } } });
};
async function applicationTransaction(db: Pool, fn: (tx: PoolClient) => Promise<ApplicationReceipt>) {
  const tx = await db.connect();
  try {
    return await withRealtimeOutboxTransaction(tx, fn, { reconcileCommit: async (verifier, receipt) => {
      const found = await verifier.query("SELECT 1 FROM public.data_cutover_application_runs WHERE id=$1::uuid AND actor_user_id=$2", [receipt.id, receipt.applied_by]);
      return found.rows.length ? "committed" : "not_committed";
    } });
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") throw new HttpError(503, "CUTOVER_APPLICATION_NOT_INSTALLED", "Le chargement de reprise n'est pas encore installé. La préparation est conservée.");
    throw error;
  }
}
export function createCutoverApplicationService(adapters: ApplicationAdapter[], db: Pool = pool, options: { audit?: ApplicationAuditWriter } = {}) {
  async function inspect(tx: PoolClient, batchId: string, expectedVersion: number, actorId: number) {
    const { batch, rows } = await loadApplicationPreparationTx(tx, batchId, expectedVersion);
    const loaded = await loadTargets(tx, batch.source_system);
    const evidence = await inspectEvidence(tx, batchId);
    for (const target of await resolveApplicationExplicitTargetsTx(tx, rows)) attachTarget(loaded.targets, loaded.ambiguous, target.alias, target);
    // A verified LINK already identifies a real native object. Publish its
    // source aliases before grouping orders, so two legacy codes linked to the
    // same customer and PO cannot create separate draft orders.
    for (const row of rows) {
      if (row.values.resolution !== "LINK" || row.issues.length || !["CUSTOMER", "SUPPLIER", "ARTICLE", "TECHNICAL_PIECE"].includes(row.domain)) continue;
      const linked = loaded.targets.get(`${row.domain}:${String(row.values.targetId ?? "").trim()}`);
      if (!linked) continue;
      attachTarget(loaded.targets, loaded.ambiguous, `${row.domain}:${row.legacy_key}`, linked);
      attachTarget(loaded.targets, loaded.ambiguous, `${row.domain}:${applicationSourceReference(row)}`, linked);
    }
    const previewTargets = new Map(loaded.targets);
    const previewAmbiguous = new Set(loaded.ambiguous);
    const operations: ApplicationOperation[] = [];
    for (const [operationKey, group] of groupsFor(rows, adapters, loaded.targets)) {
      const first = group.rows[0];
      const prior = group.rows.map((row) => loaded.byKey.get(`${row.domain}:${row.legacy_key}`));
      const allApplied = prior.every(Boolean);
      const blockers: Array<CutoverIssue & { row_id?: string }> = group.rows.flatMap((row) => [...row.issues.map((issue) => ({ ...issue, row_id: row.id })), ...evidence.blockers.filter((issue) => issue.row_id === row.id)]);
      if (!allApplied && ["SALES_ORDER", "SUPPLIER_ORDER", "INTERNAL_DEMAND"].includes(first.domain)) {
        const previousGroup = await tx.query("SELECT 1 FROM public.data_cutover_application_order_groups WHERE source_system=$1 AND domain=$2 AND group_key=$3", [batch.source_system, first.domain, operationKey]);
        if (previousGroup.rows.length) blockers.push({ field: null, code: "CUTOVER_ORDER_GROUP_ALREADY_APPLIED", message: "Cette commande a déjà été reprise dans un autre lot. Compléter la commande CERP existante avec le parcours métier, sans créer un second brouillon de reprise.", row_id: first.id });
      }
      if (prior.some(Boolean) && !allApplied) blockers.push({ field: null, code: "CUTOVER_GROUP_PARTIALLY_APPLIED", message: "Une partie de cette commande a déjà été reprise. Contrôler la correspondance avant de créer un autre brouillon.", row_id: first.id });
      for (let index = 0; index < group.rows.length; index++) if (prior[index] && prior[index]!.payload_hash !== applicationRowHash(group.rows[index])) blockers.push({ field: null, code: "CUTOVER_SOURCE_ALREADY_APPLIED_CHANGED", message: "Cette référence a déjà été chargée avec un autre contenu. Corriger sa fiche native, sans rejouer la reprise.", row_id: group.rows[index].id });
      if (!group.adapter) blockers.push({ field: null, code: "CUTOVER_DOMAIN_NOT_AVAILABLE", message: "Le chargement de ce domaine n'est pas encore qualifié. Le conserver hors du lot actif.", row_id: first.id });
      if (!allApplied && group.adapter && !blockers.length) {
        const context: ApplicationContext = { client: tx, batchId, actorId, sourceSystem: batch.source_system, correlationId: "preview", operationKey, rows: group.rows, targets: previewTargets };
        try { blockers.push(...await group.adapter.inspect(context)); }
        catch (error) { if (!(error instanceof HttpError)) throw error; blockers.push(errorIssue(error)); }
      }
      const mode = group.adapter?.kind === "REFERENCE" && group.rows.every((row) => row.values.resolution === "LINK") ? "LINK" : group.adapter?.mode ?? "ARCHIVE";
      const operation: ApplicationOperation = { key: operationKey, kind: group.adapter?.kind ?? first.domain, domain: first.domain, label: `${catalogFor(first.domain).label} · ${String(first.values.customerOrderNumber ?? first.values.supplierOrderNumber ?? applicationSourceReference(first))}`, source_row_ids: group.rows.map((row) => row.id), source_count: group.rows.length, state: blockers.length ? "BLOCKED" : allApplied ? "ALREADY_APPLIED" : "READY", mode, blockers, effects: group.adapter?.effects ?? [] };
      if (allApplied && !blockers.length) operation.targets = [...new Map(prior.map((row) => { const target = applicationTargetLink({ id: row!.target_id, type: row!.target_type, reference: row!.target_reference }, batchId); return [`${target.type}:${target.id}`, target] as const; })).values()];
      operations.push(operation);
      if (operation.state === "READY" && group.adapter?.plannedTargetType) {
        for (const row of group.rows) {
          const explicit = typeof row.values.targetId === "string" ? row.values.targetId.trim() : "";
          const linked = explicit ? loaded.targets.get(`${row.domain}:${explicit}`) : null;
          const target = linked ?? plannedTarget(row, group.adapter.plannedTargetType);
          attachTarget(previewTargets, previewAmbiguous, `${row.domain}:${row.legacy_key}`, target);
          attachTarget(previewTargets, previewAmbiguous, `${row.domain}:${applicationSourceReference(row)}`, target);
        }
      }
    }
    const blockers = operations.flatMap((operation) => operation.blockers);
    if (!rows.length) blockers.push({ field: null, code: "CUTOVER_EMPTY_SCOPE", message: "Choisir au moins une fiche pour ce lot." });
    if (rows.length > MAX_APPLICATION_ROWS) blockers.push({ field: null, code: "CUTOVER_APPLICATION_SCOPE_TOO_LARGE", message: `Limiter chaque chargement à ${MAX_APPLICATION_ROWS} fiches pour vérifier le résultat et garder une transaction courte.` });
    const preview: ApplicationPreview = { batch_id: batch.id, batch_version: batch.version, preview_hash: hashCutover({ batchId, version: batch.version, rows: rows.map((row) => [row.id, row.version, applicationRowHash(row)]), evidence: evidence.snapshot, operations }), can_apply: !blockers.length && operations.some((operation) => operation.state === "READY"), posting_available: adapters.length > 0, generated_at: new Date().toISOString(), external_effects: false, summary: { selected_rows: rows.length, ready_operations: operations.filter((operation) => operation.state === "READY").length, blocked_operations: operations.filter((operation) => operation.state === "BLOCKED").length, applied_rows: operations.filter((operation) => operation.state === "ALREADY_APPLIED").reduce((sum, operation) => sum + operation.source_count, 0) }, operations, blockers };
    return { batch, rows, loaded, preview };
  }
  return {
    preview: (batchId: string, version: number, actorId: number) => transaction(db, async (tx) => (await inspect(tx, batchId, version, actorId)).preview),
    list: (batchId: string) => transaction(db, async (tx) => ({ items: (await tx.query<{ receipt: ApplicationReceipt }>("SELECT receipt FROM public.data_cutover_application_runs WHERE batch_id=$1::uuid ORDER BY created_at DESC LIMIT 50", [batchId])).rows.map((row) => row.receipt) })),
    apply: (batchId: string, input: ApplicationApplyInput, actorId: number, idempotencyKey: string, correlationId: string) => applicationTransaction(db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["cutover:application"]);
      const requestHash = hashCutover({ batchId, input });
      const existing = await tx.query<{ request_hash: string; receipt: ApplicationReceipt }>("SELECT request_hash,receipt FROM public.data_cutover_application_runs WHERE actor_user_id=$1 AND idempotency_key=$2", [actorId, idempotencyKey]);
      if (existing.rows[0]) { if (existing.rows[0].request_hash !== requestHash) throw new HttpError(409, "CUTOVER_APPLICATION_IDEMPOTENCY_CONFLICT", "Cette demande a déjà servi pour un autre chargement."); return { ...existing.rows[0].receipt, replayed: true }; }
      const checked = await inspect(tx, batchId, input.expected_version, actorId);
      if (checked.preview.preview_hash !== input.expected_preview_hash) throw new HttpError(409, "CUTOVER_APPLICATION_STALE_PREVIEW", "Le contrôle de chargement a changé. Relancer le contrôle avant de confirmer.");
      if (!checked.preview.can_apply) throw new HttpError(409, "CUTOVER_APPLICATION_BLOCKED", "Le lot contient encore des points bloquants. Aucune écriture métier n'a été effectuée.", { blockers: checked.preview.blockers.slice(0, 30) });
      const runId = randomUUID();
      const receipt: ApplicationReceipt = { id: runId, batch_id: batchId, status: "APPLIED", created_at: new Date().toISOString(), applied_by: actorId, replayed: false, operations: [], business_writes: false, external_effects: false };
      for (const operation of checked.preview.operations) {
        if (operation.state === "ALREADY_APPLIED") { receipt.operations.push({ key: operation.key, kind: operation.kind, label: operation.label, status: "ALREADY_APPLIED", targets: operation.targets ?? [] }); continue; }
        const adapter = adapters.find((entry) => entry.kind === operation.kind && entry.domains.includes(operation.domain));
        if (!adapter) throw new HttpError(409, "CUTOVER_APPLICATION_ADAPTER_CHANGED", "Le parcours de chargement a changé. Relancer le contrôle.");
        const rows = checked.rows.filter((row) => operation.source_row_ids.includes(row.id));
        const context: ApplicationContext = { client: tx, batchId, actorId, sourceSystem: checked.batch.source_system, correlationId, operationKey: operation.key, rows, targets: checked.loaded.targets };
        // Preview-only dependencies must never reach a native writer, even if a
        // future adapter accidentally adds one to the application target map.
        if ([...context.targets.values()].some((target) => target.planned === true)) throw new Error("CUTOVER_PREVIEW_TARGET_IN_APPLICATION");
        const blockers = await adapter.inspect(context);
        if (blockers.length) throw new HttpError(409, "CUTOVER_APPLICATION_BLOCKED", "Une dépendance a changé pendant le contrôle. Le chargement complet est annulé.", { blockers: blockers.slice(0, 30) });
        const applied = await adapter.apply(context);
        if (applied.targets.length !== rows.length || new Set(applied.targets.map((target) => target.rowId)).size !== rows.length) throw new Error("CUTOVER_APPLICATION_INCOMPLETE_RECEIPT");
        const publicTargets: ApplicationTarget[] = [];
        for (const target of applied.targets) {
          const row = rows.find((entry) => entry.id === target.rowId && entry.domain === target.domain);
          if (!row || !target.targetId || !target.targetType) throw new Error("CUTOVER_APPLICATION_TARGET_MISMATCH");
          await tx.query(`INSERT INTO public.data_cutover_application_crosswalk(source_system,domain,legacy_key,source_reference,payload_hash,values_snapshot,source_snapshot,target_type,target_id,target_reference,batch_id,row_id,run_id,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::uuid,$12::uuid,$13::uuid,$14)`, [checked.batch.source_system, row.domain, row.legacy_key, applicationSourceReference(row), applicationRowHash(row), JSON.stringify(row.values), JSON.stringify({ source_id: row.source_id, legacy_key: row.legacy_key, sheet: row.sheet, row_number: row.row_number, source_values: row.source_values, source_issues: row.source_issues, review_note: row.review_note }), target.targetType, target.targetId, target.targetReference, batchId, row.id, runId, actorId]);
          const resolved = { id: target.targetId, reference: target.targetReference, type: target.targetType };
          attachTarget(checked.loaded.targets, checked.loaded.ambiguous, `${row.domain}:${row.legacy_key}`, resolved);
          attachTarget(checked.loaded.targets, checked.loaded.ambiguous, `${row.domain}:${applicationSourceReference(row)}`, resolved);
          publicTargets.push(applicationTargetLink(resolved, batchId));
        }
        const targets = [...new Map(publicTargets.map((target) => [`${target.type}:${target.id}`, target])).values()];
        await tx.query("INSERT INTO public.data_cutover_application_operations(run_id,operation_key,kind,source_row_ids,targets) VALUES($1::uuid,$2,$3,$4::uuid[],$5::jsonb)", [runId, operation.key, operation.kind, operation.source_row_ids, JSON.stringify(targets)]);
        if (["SALES_ORDER", "SUPPLIER_ORDER", "INTERNAL_DEMAND"].includes(operation.domain)) {
          // CREATE dependencies now have their actual IDs. Claim the resolved
          // native partner/PO identity, rather than a preview-only legacy key.
          const claimKey = hashCutover({ domain: operation.domain, kind: adapter.kind, group: adapter.groupKey(rows[0], checked.loaded.targets) });
          await tx.query("INSERT INTO public.data_cutover_application_order_groups(source_system,domain,group_key,run_id,targets) VALUES($1,$2,$3,$4::uuid,$5::jsonb)", [checked.batch.source_system, operation.domain, claimKey, runId, JSON.stringify(targets)]);
        }
        receipt.operations.push({ key: operation.key, kind: operation.kind, label: operation.label, status: "APPLIED", targets });
        if (operation.mode !== "LINK") receipt.business_writes = true;
      }
      await tx.query("INSERT INTO public.data_cutover_application_runs(id,batch_id,batch_version,actor_user_id,idempotency_key,request_hash,preview_hash,checkpoint,receipt) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)", [runId, batchId, checked.batch.version, actorId, idempotencyKey, requestHash, input.expected_preview_hash, JSON.stringify(input.checkpoint), JSON.stringify(receipt)]);
      await tx.query("INSERT INTO public.data_cutover_events(batch_id,actor_user_id,action,details) VALUES($1::uuid,$2,'APPLICATION_COMMITTED',$3::jsonb)", [batchId, actorId, JSON.stringify({ run_id: runId, operation_count: receipt.operations.length, row_count: checked.rows.length, preview_hash: input.expected_preview_hash, business_writes: receipt.business_writes, external_effects: false })]);
      await (options.audit ?? writeApplicationAudit)(tx, receipt);
      return receipt;
    }),
  };
}
