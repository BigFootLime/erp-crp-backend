import type { PoolClient } from "pg";
import type { DemandImportPreviewRow, DemandImportResult } from "../../demand-import/types";

type Candidate = DemandImportPreviewRow["candidate"];
type FirmMatch = {
  order_key: string;
  line_key: string;
  schedule_key: string;
  article_id: string;
  article_codes: string[];
  contract_line_id: string | null;
  contract_reference: string | null;
  unit: string;
  remaining_quantity: string;
};

const groupKey = (order: string | undefined, article: string | undefined) =>
  JSON.stringify([order, article]);

function issue(row: DemandImportPreviewRow, code: string, message: string) {
  row.diagnostics.push({ level: "ERROR", code, message, field: null, row_number: row.row_number });
}

/**
 * Date-only AR requests can use a persisted commercial link. Every candidate in
 * the authorized client/site is counted before using a unique match. The
 * source row position, need date and quantity never disambiguate a schedule.
 */
export async function qualifyClayensAr(
  tx: PoolClient,
  clientId: string,
  site: string,
  parsed: DemandImportResult,
) {
  const orders = [...new Set(parsed.preview_rows.flatMap(({ candidate }) =>
    candidate.external_order_key ? [candidate.external_order_key] : [],
  ))];
  const { rows: bindings } = await tx.query<FirmMatch>(
    `SELECT b.external_order_key order_key,b.external_line_key line_key,b.external_schedule_key schedule_key,
            b.article_id::text, b.contract_line_id::text, contract.reference contract_reference, a.unite unit,
            ARRAY[a.code::text] || ARRAY(
              SELECT DISTINCT m.external_code FROM public.demand_pilot_article_mappings m
              WHERE m.client_id=b.client_id AND m.article_id=b.article_id
            ) article_codes,
            COALESCE(balance.quantity,0)::text remaining_quantity
       FROM public.demand_pilot_firm_binding_scopes b
       JOIN public.articles a ON a.id=b.article_id
       JOIN public.delivery_promise_roots root ON root.id=b.promise_root_id
       JOIN public.commande_ar_log ar ON ar.id=root.ar_id AND ar.commande_id=root.commande_id AND ar.status='SENT'
       JOIN public.commande_client c ON c.id=root.commande_id AND c.client_id=b.client_id
       JOIN public.commande_ligne line ON line.id=root.line_id
                                   AND line.commande_id=c.id AND line.article_id=b.article_id
       LEFT JOIN public.client_contracts contract ON contract.id=b.contract_id AND contract.client_id=b.client_id
       LEFT JOIN LATERAL (
         SELECT sum(GREATEST(p.quantity-COALESCE(shipped.quantity,0),0)) quantity
         FROM public.delivery_promise_parts p
         LEFT JOIN LATERAL (
           SELECT sum(s.quantity) quantity FROM public.delivery_promise_shipments s WHERE s.part_id=p.id
         ) shipped ON true
         WHERE p.root_id=root.id AND p.retired_at IS NULL
       ) balance ON true
      WHERE b.client_id=$1 AND b.external_site=$2 AND b.external_order_key=ANY($3::text[])`,
    [clientId, site, orders],
  );
  const byGroup = new Map<string, FirmMatch[]>();
  for (const binding of bindings) {
    for (const code of new Set(binding.article_codes)) {
      const key = groupKey(binding.order_key, code);
      const group = byGroup.get(key) ?? [];
      group.push(binding);
      byGroup.set(key, group);
    }
  }
  const sourceCounts = new Map<string, number>();
  const sourceWithoutIdentity = new Set<string>();
  for (const { candidate } of parsed.preview_rows) {
    const key = groupKey(candidate.external_order_key, candidate.article_code);
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
    if (!candidate.external_line_key || !candidate.external_schedule_key)
      sourceWithoutIdentity.add(key);
  }

  const matched = new Map<DemandImportPreviewRow, FirmMatch>();
  for (const row of parsed.preview_rows) {
    const c: Candidate = row.candidate;
    const key = groupKey(c.external_order_key, c.article_code);
    if (c.kind !== "FIRM") {
      issue(row, "CLAYENS_AR_FIRM_REQUIRED", "Une demande d’AR doit cibler une échéance ferme.");
      continue;
    }
    const candidates = (byGroup.get(key) ?? []).filter((binding) =>
      (!c.external_line_key || c.external_line_key === binding.line_key) &&
      (!c.external_schedule_key || c.external_schedule_key === binding.schedule_key),
    );
    if (candidates.length > 1 || (sourceWithoutIdentity.has(key) && (sourceCounts.get(key) ?? 0) > 1)) {
      issue(row, "CLAYENS_AR_AMBIGUOUS", "Plusieurs échéances correspondent. Indiquez les identifiants stables de ligne et d’échéance.");
      continue;
    }
    const binding = candidates[0];
    if (!binding) {
      issue(row, "CLAYENS_AR_NO_BINDING", "Aucun rattachement ADV confirmé à une promesse de ce site. Ligne à qualifier.");
      continue;
    }
    c.external_line_key = binding.line_key;
    c.external_schedule_key = binding.schedule_key;
    c.contract_reference ??= binding.contract_reference ?? undefined;
    row.diagnostics = row.diagnostics.filter((diagnostic) =>
      diagnostic.code !== "REQUIRED_FIELD_MISSING" ||
      !["external_line_key", "external_schedule_key"].includes(diagnostic.field ?? ""),
    );
    matched.set(row, binding);
  }
  return matched;
}

export function assertClayensArMatch(
  row: DemandImportPreviewRow,
  match: FirmMatch | undefined,
  resolved: NonNullable<DemandImportPreviewRow["resolved"]>,
) {
  if (!match || match.article_id !== resolved.article_id ||
      match.contract_line_id !== resolved.contract_line_id || match.unit !== resolved.unit) {
    issue(row, "CLAYENS_AR_SCOPE_CHANGED", "L’article, l’unité ou le contrat ne correspondent plus à la promesse rattachée.");
  } else if (resolved.quantity !== Number(match.remaining_quantity)) {
    issue(row, "CLAYENS_AR_BALANCE_CHANGED", "Le solde du relevé diffère du solde ERP. Vérifiez les expéditions et la quantité avant transmission.");
  }
  return !row.diagnostics.some((diagnostic) => diagnostic.level === "ERROR");
}
