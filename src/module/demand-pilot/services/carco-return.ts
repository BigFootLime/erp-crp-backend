import { industrialTx } from "../../planning/services/industrial-runs.service";
import { HttpError } from "../../../utils/httpError";
import { getCarco } from "./carco-review.service";

function cell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
/** Human-reviewed return file. One row per external schedule, even when CRP splits the promise. */
export async function exportCarco(
  scope: { clientId: string; site: string },
  id: string,
  portalAccountId?: string,
) {
  const review = await getCarco(scope, id);
  if (!review?.latest)
    throw new HttpError(
      409,
      "CARCO_STALE",
      "Exportez le dernier relevé du site.",
    );
  const decisions = await industrialTx(async (tx) => (
    await tx.query<{
      external_order_key: string;
      external_line_key: string;
      external_schedule_key: string;
      status: string;
    }>(
      `SELECT revision.external_order_key,revision.external_line_key,revision.external_schedule_key,revision.status
         FROM public.demand_pilot_revisions revision
         JOIN public.demand_pilot_imports batch ON batch.id=revision.import_id
        WHERE batch.carco_review_id=$1::uuid AND revision.client_id=$2 AND revision.external_site=$3
        ORDER BY revision.revision_no`,
      [id, scope.clientId, scope.site],
    )
  ).rows);
  const decisionByLine = new Map(decisions.map((row) => [
    JSON.stringify([row.external_order_key, row.external_line_key, row.external_schedule_key]), row.status,
  ]));
  const promises = await industrialTx(
    async (tx) =>
      (
        await tx.query<{
          order_key: string;
          line_key: string;
          schedule_key: string;
          article_id: string;
          contract_line_id: string | null;
          parts: string;
          agreed_date: string | null;
        }>(
          `SELECT b.external_order_key order_key,b.external_line_key line_key,b.external_schedule_key schedule_key,b.article_id::text,b.contract_line_id::text,
      string_agg((p.quantity-COALESCE(ship.quantity,0))::text || ' @ ' || p.due_date::text,' / ' ORDER BY p.due_date,p.id) parts,
      CASE WHEN count(DISTINCT p.due_date)=1 THEN min(p.due_date)::text END agreed_date
     FROM public.demand_pilot_firm_binding_scopes b
     JOIN public.delivery_promise_roots r ON r.id=b.promise_root_id
     JOIN public.commande_client c ON c.id=r.commande_id AND c.client_id=b.client_id
     JOIN public.delivery_promise_parts p ON p.root_id=r.id AND p.retired_at IS NULL
     LEFT JOIN LATERAL (
       SELECT sum(shipment.quantity) quantity FROM public.delivery_promise_shipments shipment WHERE shipment.part_id=p.id
     ) ship ON true
     WHERE b.client_id=$1 AND b.external_site=$2 AND b.external_order_key=ANY($3::text[])
       AND p.quantity>COALESCE(ship.quantity,0)
       AND ($4::uuid IS NULL OR EXISTS (
         SELECT 1 FROM public.delivery_promise_site_evidence site
         JOIN public.client_portal_delivery_site_bindings allowed ON allowed.delivery_address_id=site.delivery_address_id
         WHERE site.root_id=r.id AND allowed.account_id=$4::uuid
       ))
     GROUP BY b.external_order_key,b.external_line_key,b.external_schedule_key,b.article_id,b.contract_line_id`,
          [
            scope.clientId,
            scope.site,
            [
              ...new Set(
                review.lines
                  .map((l) => l.candidate.external_order_key)
                  .filter(Boolean),
              ),
            ],
            portalAccountId ?? null,
          ],
        )
      ).rows,
  );
  const terms = new Map(
    promises.map((p) => [
      JSON.stringify([
        p.order_key,
        p.line_key,
        p.schedule_key,
        p.article_id,
        p.contract_line_id,
      ]),
      p,
    ]),
  );
  const rows: unknown[][] = [
    [
      "NUM_CDE",
      "NUM_LIGNE_CDE",
      "ID_ECHEANCE",
      "ARTICLE",
      "LIBELLE_ARTICLE",
      "TYPE_CDE",
      "DATE_CDE",
      "PRUHA_US_EUR",
      "QTE_LIV",
      "QTE_SOLDE",
      "DATE_BESOIN",
      "DATE_CONF_SOURCE",
      "PROMESSES_CRP_QTE_DATE",
      "VERSION_EXPORT",
      "DATE_DEMANDEE",
      "DATE_CONF",
      "STATUT_CRP",
      "MOTIFS_CRP",
      "DEMANDE_CRP",
    ],
  ];
  for (const { candidate: c, diagnostics, resolved, source } of review.lines) {
    const errors = diagnostics.filter((diagnostic) => diagnostic.level === "ERROR");
    const promised =
      c.kind !== "FIRM" ||
      !resolved ||
      errors.length
        ? null
        : terms.get(
            JSON.stringify([
              c.external_order_key,
              c.external_line_key,
              c.external_schedule_key,
              resolved.article_id,
              resolved.contract_line_id,
            ]),
          );
    rows.push([
      c.external_order_key,
      c.external_line_key,
      c.external_schedule_key,
      c.article_code,
      source?.designation,
      source?.order_type,
      c.customer_order_date,
      source?.unit_price,
      c.source_delivered_quantity,
      c.quantity,
      c.need_date,
      c.source_confirmed_date,
      promised?.parts,
      review.version,
      c.source_requested_date,
      promised?.agreed_date,
      errors.length
        ? "A_QUALIFIER"
        : promised?.agreed_date ? "AR_ENGAGE" : promised ? "PROMESSE_FRACTIONNEE" : "ENGAGEMENT_NON_DISPONIBLE",
      Array.from(new Set(errors.map((error) => error.code))).join(" / "),
      decisionByLine.get(JSON.stringify([c.external_order_key, c.external_line_key, c.external_schedule_key]))
        ?? (errors.length ? "A_QUALIFIER" : "RECUE"),
    ]);
  }
  return "\ufeff" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
}
