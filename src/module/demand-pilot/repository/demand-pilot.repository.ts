import { createHash, randomUUID } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { readIndustrialPolicy } from "../../planning/repository/industrial-policy.repository";
import { lockDemandSite } from "./demand-ingest.repository";
import { assessDemandStock } from "../../planning/services/industrial-promise.service";
import { processDemandMaterialization } from "../services/demand-pilot-materialization.service";
import type { DemandRow } from "../types/demand-pilot.types";
import type { z } from "zod";
import type { demandRowSchema } from "../validators/demand-pilot.validators";

type CanonicalRow = z.infer<typeof demandRowSchema>;
type Actor = { userId?: number; portalAccountId?: string };
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const currentWhere = `NOT EXISTS(SELECT 1 FROM public.demand_pilot_revisions n WHERE n.client_id=r.client_id AND n.external_site=r.external_site AND n.external_order_key=r.external_order_key AND n.external_line_key=r.external_line_key AND n.external_schedule_key=r.external_schedule_key AND n.revision_no>r.revision_no)`;
const fields = `r.id::text,r.import_id::text,r.client_id,r.external_site,r.external_order_key,r.external_line_key,r.external_schedule_key,r.source_version,r.source_as_of::text,r.kind,r.quantity::text,r.unit,r.quantity_basis,r.need_date::text,r.article_code,r.article_id::text,r.contract_id::text,r.contract_line_id::text,r.customer_reference,r.comment,r.revision_no,r.diff_type,r.status,r.before_snapshot,r.after_snapshot,r.created_at::text,r.decided_at::text,r.decision_reason,r.scenario_code,r.planner_evidence,r.materialization_ref,r.accepted_need_date::text,
 (SELECT jsonb_build_object('id',o.id,'due_date',o.due_date,'customer_message',o.customer_message,'status',o.status) FROM public.demand_counter_offers o
  WHERE o.revision_id=r.id ORDER BY o.created_at DESC,o.id DESC LIMIT 1) AS counter_offer`;
const snapshot = (r: CanonicalRow) => ({
  ...r,
  quantity_basis: r.quantity_basis ?? "TOTAL",
  article_code: r.article_code ?? null,
  article_id: r.article_id ?? null,
  contract_id: r.contract_id ?? null,
  contract_line_id: r.contract_line_id ?? null,
  customer_reference: r.customer_reference ?? null,
  comment: r.comment ?? null,
});
const actorValues = (a: Actor) =>
  [a.userId ?? null, a.portalAccountId ?? null] as const;

export async function assertDemandSiteAccess(
  tx: { query: Function },
  clientId: string,
  accountId: string,
  site: string,
) {
  const allowed = await tx.query(
    `SELECT 1 FROM public.client_portal_accounts a JOIN public.client_portal_demand_sites s ON s.portal_account_id=a.id WHERE a.id=$1::uuid AND a.client_id=$2 AND a.status='ACTIVE' AND s.external_site=$3 FOR SHARE OF a`,
    [accountId, clientId, site],
  );
  if (!allowed.rowCount)
    throw new HttpError(
      403,
      "DEMAND_PILOT_PORTAL_SITE",
      "Ce compte portail n’est pas autorisé pour ce site.",
    );
}

/** Resolves only explicit, client-scoped commercial mappings; no article or contract is guessed. */
export async function resolveDemandRow(
  tx: { query: Function },
  clientId: string,
  row: CanonicalRow,
): Promise<CanonicalRow> {
  if(row.kind==="FORECAST"&&!row.contract_reference&&!row.contract_id)
    throw new HttpError(422,"DEMAND_FORECAST_CONTRACT_REQUIRED","Indiquez le contrat de cette prévision.");
  if (!row.article_code)
    throw new HttpError(
      422,
      "DEMAND_PILOT_ARTICLE_MAPPING_REQUIRED",
      "Le code article client est requis.",
    );
  const alias = (
    await tx.query(
      `SELECT a.id::text,a.code,a.unite,
   ($4::numeric*m.units_per_external)::text AS converted FROM public.demand_pilot_article_mappings m
   JOIN public.articles a ON a.id=m.article_id JOIN public.article_client_links link ON link.article_id=a.id AND link.client_id=m.client_id
   WHERE m.client_id=$1 AND m.external_code=$2 AND m.external_unit=$3 AND a.archived_at IS NULL AND a.status='VALIDE' AND a.is_active
   FOR SHARE`,
      [clientId, row.article_code, row.unit.toUpperCase(), row.quantity],
    )
  ).rows[0];
  if (alias) {
    const converted = Number(alias.converted);
    if (
      (row.article_id && row.article_id !== alias.id) ||
      converted <= 0 ||
      converted > 1e9 ||
      Math.round(converted * 1000) / 1000 !== converted
    )
      throw new HttpError(
        422,
        "ARTICLE_MAPPING_CONVERSION",
        "Correspondance article ou conversion incompatible avec la précision de CERP.",
      );
    row = {
      ...row,
      article_id: alias.id,
      article_code: alias.code,
      unit: alias.unite,
      quantity: converted,
    };
  }
  const article = (
    await tx.query(
      row.article_id
        ? `SELECT a.id::text,a.code,a.unite FROM public.articles a JOIN public.article_client_links acl ON acl.article_id=a.id AND acl.client_id=$3 WHERE a.id=$1::uuid AND a.code=$2 AND a.is_active AND a.status='VALIDE' AND a.archived_at IS NULL FOR SHARE`
        : `SELECT a.id::text,a.code,a.unite FROM public.articles a JOIN public.article_client_links acl ON acl.article_id=a.id AND acl.client_id=$2 WHERE a.code=$1 AND a.is_active AND a.status='VALIDE' AND a.archived_at IS NULL FOR SHARE`,
      row.article_id
        ? [row.article_id, row.article_code, clientId]
        : [row.article_code, clientId],
    )
  ).rows;
  if (article.length > 1)
    throw new HttpError(
      422,
      "DEMAND_PILOT_ARTICLE_MAPPING_AMBIGUOUS",
      "Le code article correspond à plusieurs articles CERP.",
    );
  const resolved = article[0];
  if (
    !resolved ||
    String(resolved.unite).trim().toUpperCase() !==
      row.unit.trim().toUpperCase()
  )
    throw new HttpError(
      422,
      "DEMAND_PILOT_ARTICLE_UNIT_INVALID",
      "L’article ou l’unité ne correspond pas au référentiel CERP.",
    );
  if (row.contract_line_id || row.contract_id) {
    if (!row.contract_id || !row.contract_line_id)
      throw new HttpError(
        422,
        "DEMAND_PILOT_CONTRACT_LINE_REQUIRED",
        "Un contrat doit désigner sa ligne explicite.",
      );
    const line = (
      await tx.query(
        `SELECT 1 FROM public.client_contracts c JOIN public.client_contract_lines l ON l.contract_id=c.id
         JOIN public.units u ON u.id=l.unit_id WHERE c.id=$1::uuid AND c.client_id=$2 AND c.status='ACTIVE' AND l.id=$3::uuid
         AND l.active AND l.article_id=$4::uuid AND lower(u.code)=lower($5) AND (c.valid_from IS NULL OR c.valid_from<=$6::date)
         AND (c.valid_until IS NULL OR c.valid_until>=$6::date) FOR SHARE`,
        [row.contract_id, clientId, row.contract_line_id, resolved.id, resolved.unite, row.need_date],
      )
    ).rows[0];
    if (!line)
      throw new HttpError(
        422,
        "DEMAND_PILOT_CONTRACT_SCOPE",
        "La ligne de contrat active ne correspond pas au client.",
      );
  }
  if (row.contract_reference && (!row.contract_id || !row.contract_line_id)) {
    const candidates = (
      await tx.query(
        `SELECT c.id::text contract_id,l.id::text contract_line_id FROM public.client_contracts c JOIN public.client_contract_lines l ON l.contract_id=c.id JOIN public.units u ON u.id=l.unit_id WHERE c.client_id=$1 AND c.reference=$2 AND c.status='ACTIVE' AND l.active AND l.article_id=$3::uuid AND lower(u.code)=lower($4) AND (c.valid_from IS NULL OR c.valid_from<=$5::date) AND (c.valid_until IS NULL OR c.valid_until>=$5::date) FOR SHARE`,
        [
          clientId,
          row.contract_reference,
          resolved.id,
          row.unit,
          row.need_date,
        ],
      )
    ).rows;
    if (candidates.length !== 1)
      throw new HttpError(
        422,
        candidates.length
          ? "DEMAND_PILOT_CONTRACT_MAPPING_AMBIGUOUS"
          : "DEMAND_PILOT_CONTRACT_MAPPING_REQUIRED",
        "Le contrat/rattachement article n’est pas résolu de manière unique.",
      );
    return {
      ...row,
      article_id: resolved.id,
      article_code: resolved.code,
      unit: String(resolved.unite).trim(),
      contract_id: candidates[0].contract_id,
      contract_line_id: candidates[0].contract_line_id,
    };
  }
  return {
    ...row,
    article_id: resolved.id,
    article_code: resolved.code,
    unit: String(resolved.unite).trim(),
  };
}

export async function listDemand(p: {
  clientId: string;
  status?: string;
  page: number;
  pageSize: number;
  portalAccountId?: string;
}) {
  const where = ["r.client_id=$1", currentWhere],
    values: unknown[] = [p.clientId];
  if (p.portalAccountId) {
    values.push(p.portalAccountId);
    where.push(
      `EXISTS(SELECT 1 FROM public.client_portal_demand_sites s WHERE s.portal_account_id=$${values.length}::uuid AND s.external_site=r.external_site)`,
    );
  }
  if (p.status) {
    values.push(p.status);
    where.push(`r.status=$${values.length}`);
  }
  const countValues = [...values];
  values.push(p.pageSize, (p.page - 1) * p.pageSize);
  const data = (
    await pool.query<DemandRow>(
      `SELECT ${fields} FROM public.demand_pilot_revisions r WHERE ${where.join(" AND ")} ORDER BY r.need_date,r.created_at DESC,r.id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
  ).rows;
  const total =
    (
      await pool.query<{ count: number }>(
        `SELECT count(*)::int count FROM public.demand_pilot_revisions r WHERE ${where.join(" AND ")}`,
        countValues,
      )
    ).rows[0]?.count ?? 0;
  return { data, pagination: { page: p.page, page_size: p.pageSize, total } };
}

export async function getDemand(
  clientId: string,
  id: string,
  portalAccountId?: string,
) {
  const scope = portalAccountId
    ? ` AND EXISTS(SELECT 1 FROM public.client_portal_demand_sites s WHERE s.portal_account_id=$3::uuid AND s.external_site=r.external_site)`
    : "";
  const row = (
    await pool.query<DemandRow>(
      `SELECT ${fields} FROM public.demand_pilot_revisions r WHERE r.id=$1::uuid AND r.client_id=$2${scope}`,
      [id, clientId, ...(portalAccountId ? [portalAccountId] : [])],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(404, "DEMAND_PILOT_NOT_FOUND", "Demande introuvable.");
  return row;
}

export { importDemand } from "./demand-ingest.repository";

export async function decideDemand(p: {
  automatic?: boolean;
  clientId: string;
  id: string;
  expectedVersion: number;
  action: "ACCEPT" | "REJECT" | "REVIEW" | "COUNTER";
  reason?: string | null;
  scenarioCode?: string | null;
  confirmedNeedDate?: string | null;
  plannerEvidence?: unknown;
  actor: Actor;
  idempotencyKey: string;
}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const target = await tx.query<{ external_site: string }>(
      "SELECT external_site FROM public.demand_pilot_revisions WHERE id=$1 AND client_id=$2",
      [p.id, p.clientId],
    );
    if (!target.rowCount)
      throw new HttpError(
        404,
        "DEMAND_PILOT_NOT_FOUND",
        "Demande introuvable.",
      );
    await lockDemandSite(tx, p.clientId, target.rows[0].external_site);
    if (p.automatic) {
      const policy = await readIndustrialPolicy(tx, p.clientId, true);
      if (!policy.auto_enabled || policy.auto_actor_id !== p.actor.userId)
        throw new HttpError(
          409,
          "PILOT_PROPOSALS_ONLY",
          "Automatisation suspendue.",
        );
      const actor = await tx.query(
        "SELECT id FROM public.users WHERE id=$1 AND is_superadmin AND lower(status) IN ('active','actif') FOR SHARE",
        [policy.auto_actor_id],
      );
      if (!actor.rowCount)
        throw new HttpError(
          403,
          "PILOT_AUTO_ACTOR_UNAVAILABLE",
          "La délégation automatique doit être renouvelée.",
        );
    }
    const row = (
      await tx.query<DemandRow>(
        `SELECT ${fields} FROM public.demand_pilot_revisions r WHERE r.id=$1::uuid AND r.client_id=$2 FOR UPDATE`,
        [p.id, p.clientId],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        404,
        "DEMAND_PILOT_NOT_FOUND",
        "Demande introuvable.",
      );
    if (
      row.revision_no !== p.expectedVersion ||
      (
        await tx.query(
          `SELECT 1 FROM public.demand_pilot_revisions n WHERE n.client_id=$1 AND n.external_site=$2 AND n.external_order_key=$3 AND n.external_line_key=$4 AND n.external_schedule_key=$5 AND n.revision_no>$6 LIMIT 1`,
          [
            row.client_id,
            row.external_site,
            row.external_order_key,
            row.external_line_key,
            row.external_schedule_key,
            row.revision_no,
          ],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "DEMAND_PILOT_STALE",
        "La demande a été remplacée par une version plus récente.",
      );
    const previous = (
      await tx.query<{ request_hash: string; revision_id: string }>(
        `SELECT request_hash,revision_id FROM public.demand_pilot_events
     WHERE actor_user_id IS NOT DISTINCT FROM $1 AND actor_portal_account_id IS NOT DISTINCT FROM $2::uuid AND idempotency_key=$3::uuid`,
        [...actorValues(p.actor), p.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.revision_id !== row.id || previous.request_hash !== hash(p))
        throw new HttpError(
          409,
          "DECISION_KEY_CONFLICT",
          "Cette tentative correspond à une autre décision.",
        );
      await tx.query("COMMIT");
      return { replayed: true, data: row };
    }
    if (!["PENDING", "REVIEW"].includes(row.status))
      throw new HttpError(
        409,
        "DEMAND_ALREADY_DECIDED",
        "Cette échéance a déjà fait l’objet d’une décision.",
      );
    if (row.diff_type === "REMOVED" && p.action === "ACCEPT")
      throw new HttpError(
        409,
        "DEMAND_MISSING_REQUIRES_CONFIRMATION",
        "Obtenir une annulation explicite avant de toucher à la commande.",
      );
    if (p.automatic && row.kind === "FIRM" && row.diff_type !== "NEW")
      throw new HttpError(
        409,
        "PROMISE_CHANGE_REVIEW",
        "Une modification de ferme déjà reçu nécessite un contrôle des engagements.",
      );
    if (p.automatic && row.kind === "FORECAST" && row.diff_type === "CHANGED") {
      const frozen = await tx.query(
        "SELECT LEAST($1::date,$2::date)<(now() AT TIME ZONE 'Europe/Paris')::date+14 AS protected",
        [
          row.need_date,
          (row.before_snapshot as { need_date?: string } | null)?.need_date ??
            row.need_date,
        ],
      );
      if (frozen.rows[0].protected)
        throw new HttpError(
          409,
          "DEMAND_FROZEN",
          "Changement prévisionnel dans les deux semaines protégées.",
        );
    }
    if ((p.action === "REJECT" || p.action === "REVIEW") && !p.reason?.trim())
      throw new HttpError(
        422,
        "DECISION_REASON_REQUIRED",
        "Précisez le motif.",
      );
    const need = p.confirmedNeedDate ?? row.need_date;
    const agreed =
      row.counter_offer?.status === "AGREED" &&
      row.counter_offer.due_date === need;
    if (
      p.action === "COUNTER" ||
      (p.action === "ACCEPT" && need !== row.need_date && !agreed)
    ) {
      if (
        p.automatic ||
        !p.actor.userId ||
        !p.reason?.trim() ||
        !p.confirmedNeedDate
      )
        throw new HttpError(
          422,
          "COUNTER_TERMS_REQUIRED",
          "Une proposition client nécessite une date et une justification.",
        );
      await tx.query(
        "UPDATE public.demand_counter_offers SET status='SUPERSEDED' WHERE revision_id=$1 AND status IN('OPEN','AGREED')",
        [row.id],
      );
      const offer = (
        await tx.query(
          "INSERT INTO public.demand_counter_offers(revision_id,due_date,customer_message,actor_id,status) VALUES($1,$2,$3,$4,'OPEN') RETURNING id",
          [row.id, need, p.reason, p.actor.userId],
        )
      ).rows[0];
      await tx.query(
        "UPDATE public.demand_pilot_revisions SET status='REVIEW',decision_reason='Contre-proposition transmise au portail.' WHERE id=$1",
        [row.id],
      );
      await tx.query(
        `INSERT INTO public.demand_pilot_events(revision_id,import_id,actor_user_id,idempotency_key,request_hash,action,payload)
       VALUES($1,$2,$3,$4,$5,'DECISION',$6)`,
        [
          row.id,
          row.import_id,
          p.actor.userId,
          p.idempotencyKey,
          hash(p),
          JSON.stringify({
            action: "COUNTER",
            counter_id: offer.id,
            due_date: need,
          }),
        ],
      );
      await tx.query("COMMIT");
      return { replayed: false, data: await getDemand(p.clientId, row.id) };
    }
    if (p.action === "ACCEPT" && row.counter_offer?.status === "OPEN")
      throw new HttpError(
        409,
        "COUNTER_ANSWER_REQUIRED",
        "Réponse du client attendue.",
      );
    let evidence: Awaited<ReturnType<typeof assessDemandStock>> | null = null;
    // A forecast is a commercial book entry, not a production/spend promise.
    // Capacity and risk ceilings are enforced downstream by PDP/CBN. Firm
    // demand still requires independently computed feasibility proof.
    if (p.action === "ACCEPT" && row.kind === "FIRM") {
      const bound = (
        await tx.query<{
          line_id: string;
          allocation_id: string;
          shipped: string;
        }>(
          `SELECT r.line_id::text,r.allocation_id::text,
        COALESCE((SELECT sum(sh.quantity) FROM public.delivery_promise_shipments sh JOIN public.delivery_promise_parts pt ON pt.id=sh.part_id WHERE pt.root_id=r.id),0)::text AS shipped
       FROM public.demand_pilot_firm_binding_scopes b JOIN public.delivery_promise_roots r ON r.id=b.promise_root_id
       JOIN public.commande_client c ON c.id=r.commande_id AND c.client_id=b.client_id
       WHERE b.client_id=$1 AND b.external_site=$2 AND b.external_order_key=$3 AND b.external_line_key=$4 AND b.external_schedule_key=$5
       AND b.article_id=$6 AND b.contract_id IS NOT DISTINCT FROM $7::uuid AND b.contract_line_id IS NOT DISTINCT FROM $8::uuid`,
          [
            row.client_id,
            row.external_site,
            row.external_order_key,
            row.external_line_key,
            row.external_schedule_key,
            row.article_id,
            row.contract_id,
            row.contract_line_id,
          ],
        )
      ).rows[0];
      const remaining =
        Number(row.quantity) -
        (bound && row.quantity_basis === "TOTAL" ? Number(bound.shipped) : 0);
      if (remaining <= 0)
        throw new HttpError(
          409,
          "FIRM_ALREADY_SHIPPED",
          "Quantité déjà livrée ou inférieure au livré.",
        );
      evidence = await assessDemandStock(tx, {
        clientId: p.clientId,
        articleId: row.article_id!,
        contractId: row.contract_id,
        quantity: remaining.toFixed(3),
        unit: row.unit,
        needDate: need,
        orderLineId: bound?.line_id,
        allocationId: bound?.allocation_id,
      });
    }
    if (
      p.action === "ACCEPT" &&
      row.kind === "FIRM" &&
      (!evidence ||
        evidence.capacity_state !== "PROVEN" ||
        evidence.cost_state !== "PROVEN")
    )
      throw new HttpError(
        409,
        "DEMAND_PILOT_EVIDENCE_REQUIRED",
        "Aucune preuve serveur ne permet cette acceptation.",
      );
    const status =
      p.action === "REJECT"
        ? "REJECTED"
        : p.action === "REVIEW"
          ? "REVIEW"
          : "ACCEPTED_PENDING_MATERIALIZATION";
    await tx.query(
      `UPDATE public.demand_pilot_revisions SET status=$3,accepted_need_date=CASE WHEN $3='ACCEPTED_PENDING_MATERIALIZATION' THEN $4::date ELSE accepted_need_date END,decided_at=now(),decided_by_user_id=$5,decision_reason=$6,scenario_code=$7,planner_evidence=$8::jsonb WHERE id=$1::uuid AND client_id=$2`,
      [
        row.id,
        p.clientId,
        status,
        need,
        p.actor.userId ?? null,
        p.reason ?? null,
        evidence?.scenario_code ?? null,
        evidence ? JSON.stringify(evidence) : null,
      ],
    );
    // Durable intent: a worker can recover this exact command after a crash;
    // uniqueness on revision prevents a duplicate ERP call or duplicate AR.
    if (p.action === "ACCEPT")
      await tx.query(
        `INSERT INTO public.demand_pilot_materialization_jobs(revision_id,idempotency_key,requested_by_user_id) VALUES($1::uuid,$2::uuid,$3) ON CONFLICT(revision_id) DO NOTHING`,
        [row.id, p.idempotencyKey, p.actor.userId ?? null],
      );
    await tx.query(
      `INSERT INTO public.demand_pilot_events(revision_id,import_id,actor_user_id,actor_portal_account_id,idempotency_key,request_hash,action,payload) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,'DECISION',$7::jsonb)`,
      [
        row.id,
        row.import_id,
        ...actorValues(p.actor),
        p.idempotencyKey,
        hash(p),
        JSON.stringify({ action: p.action, status, need_date: need }),
      ],
    );
    await tx.query("COMMIT");
    if (p.action === "ACCEPT")
      void processDemandMaterialization(row.id).catch(() => undefined);
    return { replayed: false, data: await getDemand(p.clientId, row.id) };
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}

export async function respondPortalDemand(p: {
  clientId: string;
  id: string;
  expectedVersion: number;
  response: "ACKNOWLEDGE" | "WITHDRAW" | "COUNTERPROPOSE";
  counterId?: string;
  proposedNeedDate?: string | null;
  comment?: string | null;
  actor: Actor;
  idempotencyKey: string;
}) {
  if (!p.actor.portalAccountId)
    throw new HttpError(
      401,
      "DEMAND_PILOT_PORTAL_ACTOR",
      "Compte portail requis.",
    );
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const site = await tx.query(
      "SELECT external_site FROM public.demand_pilot_revisions WHERE client_id=$1 AND id=$2",
      [p.clientId, p.id],
    );
    if (!site.rowCount)
      throw new HttpError(
        404,
        "DEMAND_PILOT_NOT_FOUND",
        "Demande introuvable.",
      );
    await lockDemandSite(tx, p.clientId, site.rows[0].external_site);
    const row = (
      await tx.query<DemandRow>(
        `SELECT ${fields} FROM public.demand_pilot_revisions r WHERE r.id=$1::uuid AND r.client_id=$2 FOR UPDATE`,
        [p.id, p.clientId],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(
        404,
        "DEMAND_PILOT_NOT_FOUND",
        "Demande introuvable.",
      );
    if (
      row.revision_no !== p.expectedVersion ||
      (
        await tx.query(
          `SELECT 1 FROM public.demand_pilot_revisions n WHERE n.client_id=$1 AND n.external_site=$2 AND n.external_order_key=$3 AND n.external_line_key=$4 AND n.external_schedule_key=$5 AND n.revision_no>$6 LIMIT 1`,
          [
            row.client_id,
            row.external_site,
            row.external_order_key,
            row.external_line_key,
            row.external_schedule_key,
            row.revision_no,
          ],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "DEMAND_PILOT_STALE",
        "La demande a été remplacée par une version plus récente.",
      );
    await assertDemandSiteAccess(
      tx,
      p.clientId,
      p.actor.portalAccountId,
      row.external_site,
    );
    const replay = (
      await tx.query(
        "SELECT request_hash,revision_id FROM public.demand_pilot_events WHERE actor_portal_account_id=$1 AND idempotency_key=$2",
        [p.actor.portalAccountId, p.idempotencyKey],
      )
    ).rows[0];
    if (replay) {
      if (replay.revision_id !== row.id || replay.request_hash !== hash(p))
        throw new HttpError(
          409,
          "RESPONSE_KEY_CONFLICT",
          "Cette tentative a déjà servi.",
        );
      await tx.query("COMMIT");
      return { replayed: true, data: row };
    }
    const offer = row.counter_offer;
    if (offer?.status === "OPEN") {
      if (p.counterId !== offer.id)
        throw new HttpError(
          409,
          "COUNTER_CHANGED",
          "Rechargez la contre-proposition avant de répondre.",
        );
      await tx.query(
        "UPDATE public.demand_counter_offers SET status=$2,answered_at=now(),answered_by=$3 WHERE id=$1 AND status='OPEN'",
        [
          offer.id,
          p.response === "ACKNOWLEDGE" ? "AGREED" : "DECLINED",
          p.actor.portalAccountId,
        ],
      );
    } else if (p.counterId)
      throw new HttpError(
        409,
        "COUNTER_CLOSED",
        "Cette proposition n’est plus ouverte.",
      );
    await tx.query(
      `INSERT INTO public.demand_pilot_events(revision_id,import_id,actor_portal_account_id,idempotency_key,request_hash,action,payload) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'PORTAL_RESPONSE',$6::jsonb)`,
      [
        row.id,
        row.import_id,
        p.actor.portalAccountId,
        p.idempotencyKey,
        hash(p),
        JSON.stringify({
          response: p.response,
          proposed_need_date: p.proposedNeedDate ?? null,
          comment: p.comment ?? null,
        }),
      ],
    );
    if (p.response === "WITHDRAW" && ["PENDING", "REVIEW"].includes(row.status))
      await tx.query(
        `UPDATE public.demand_pilot_revisions SET status='REJECTED',decision_reason=COALESCE($3,decision_reason),decided_at=now() WHERE id=$1::uuid AND client_id=$2`,
        [row.id, p.clientId, p.comment ?? "Retirée par le client"],
      );
    if (
      p.response === "COUNTERPROPOSE" &&
      ["PENDING", "REVIEW"].includes(row.status)
    )
      await tx.query(
        `UPDATE public.demand_pilot_revisions SET status='REVIEW',decision_reason=COALESCE($3,decision_reason) WHERE id=$1::uuid AND client_id=$2`,
        [row.id, p.clientId, p.comment ?? "Contre-proposition client"],
      );
    await tx.query("COMMIT");
    return {
      replayed: false,
      data: await getDemand(p.clientId, row.id, p.actor.portalAccountId),
    };
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}
