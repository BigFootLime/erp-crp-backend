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
) {
  const review = await getCarco(scope, id);
  if (!review?.latest)
    throw new HttpError(
      409,
      "CARCO_STALE",
      "Exportez le dernier relevé du site.",
    );
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
        }>(
          `SELECT b.external_order_key order_key,b.external_line_key line_key,b.external_schedule_key schedule_key,b.article_id::text,b.contract_line_id::text,
      string_agg(p.quantity::text || ' @ ' || p.due_date::text,' / ' ORDER BY p.due_date,p.id) parts
     FROM public.demand_pilot_firm_binding_scopes b
     JOIN public.delivery_promise_roots r ON r.id=b.promise_root_id
     JOIN public.commande_client c ON c.id=r.commande_id AND c.client_id=b.client_id
     JOIN public.delivery_promise_parts p ON p.root_id=r.id AND p.retired_at IS NULL
     WHERE b.client_id=$1 AND b.external_site=$2 AND b.external_order_key=ANY($3::text[])
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
      p.parts,
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
    ],
  ];
  for (const { candidate: c, diagnostics, resolved, source } of review.lines) {
    const promised =
      c.kind !== "FIRM" ||
      !resolved ||
      diagnostics.some((d) => d.level === "ERROR")
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
      promised,
      review.version,
    ]);
  }
  return "\ufeff" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
}
