import type { PoolClient } from "pg";
import type {
  DemandImportPreviewRow,
  DemandImportResult,
} from "../../demand-import/types";

type Alias = { external_code: string; external_unit: string };
type Binding = {
  order_key: string;
  line_key: string;
  article_code: string;
  schedule_key: string;
  split: boolean;
};
// Once a commercial line has split, an unkeyed row no longer proves which
// delivery survived, even if a later export only contains one row.
export const observedCarcoSplit = `EXISTS (SELECT 1 FROM public.carco_reviews v
  CROSS JOIN LATERAL jsonb_array_elements(v.preview->'preview_rows') line
  WHERE v.client_id=b.client_id AND v.external_site=b.external_site
    AND line->'candidate'->>'external_order_key'=b.order_key AND line->'candidate'->>'external_line_key'=b.line_key
  GROUP BY v.id HAVING count(*)>1)`;
const lineKey = (order?: string, line?: string) =>
  JSON.stringify([order, line]);

export async function qualifyCarcoReferences(
  tx: PoolClient,
  client: string,
  site: string,
  parsed: DemandImportResult,
) {
  const codes = [
    ...new Set(
      parsed.preview_rows.map((r) => r.candidate.article_code).filter(Boolean),
    ),
  ];
  const aliases = (
    await tx.query<Alias>(
      `SELECT m.external_code,m.external_unit FROM public.demand_pilot_article_mappings m
    JOIN public.articles a ON a.id=m.article_id AND a.archived_at IS NULL AND a.status='VALIDE' AND a.is_active
    JOIN public.article_client_links l ON l.article_id=a.id AND l.client_id=m.client_id
    WHERE m.client_id=$1 AND m.external_code=ANY($2::text[])`,
      [client, codes],
    )
  ).rows;
  const known = (
    await tx.query<{ code: string; unite: string }>(
      `SELECT a.code,a.unite FROM public.articles a
    JOIN public.article_client_links l ON a.id=l.article_id AND l.client_id=$1
    WHERE a.code=ANY($2::text[]) AND a.is_active AND a.archived_at IS NULL AND a.status='VALIDE'`,
      [client, codes],
    )
  ).rows;
  const bindings = (
    await tx.query<Binding>(
      `SELECT order_key,line_key,article_code,schedule_key,${observedCarcoSplit} AS split FROM public.carco_schedule_bindings b
    WHERE client_id=$1 AND external_site=$2 AND order_key=ANY($3::text[])`,
      [
        client,
        site,
        [
          ...new Set(
            parsed.preview_rows
              .map((r) => r.candidate.external_order_key)
              .filter(Boolean),
          ),
        ],
      ],
    )
  ).rows;
  const units = new Map<string, Set<string>>();
  for (const alias of aliases) {
    const set = units.get(alias.external_code) ?? new Set<string>();
    set.add(alias.external_unit);
    units.set(alias.external_code, set);
  }
  const exactCodes = new Set(known.map((a) => a.code));
  const bound = new Map(
    bindings.map((b) => [lineKey(b.order_key, b.line_key), b]),
  );
  const lineCounts = new Map<string, number>();
  const unidentified = new Set<string>();
  const scheduleCounts = new Map<string,number>();
  for (const { candidate: c } of parsed.preview_rows) {
    const id = lineKey(c.external_order_key, c.external_line_key);
    lineCounts.set(id, (lineCounts.get(id) ?? 0) + 1);
    if(!c.external_schedule_key) unidentified.add(id);
    else {
      const schedule=JSON.stringify([id,c.external_schedule_key]);
      scheduleCounts.set(schedule,(scheduleCounts.get(schedule)??0)+1);
    }
  }
  const error = (row: DemandImportPreviewRow, code: string, message: string) =>
    row.diagnostics.push({
      level: "ERROR",
      code,
      message,
      row_number: row.row_number,
      field: null,
    });
  for (const row of parsed.preview_rows) {
    const c = row.candidate,
      id = lineKey(c.external_order_key, c.external_line_key);
    const binding = bound.get(id);
    if (c.external_schedule_key && (scheduleCounts.get(JSON.stringify([id,c.external_schedule_key]))??0)>1 &&
      !row.diagnostics.some(d=>d.code==="DUPLICATE_COMPOSITE_KEY"))
      error(row,"DUPLICATE_COMPOSITE_KEY","Le même identifiant d’échéance figure plusieurs fois dans cet envoi.");
    if(c.external_schedule_key && unidentified.has(id))
      error(row,"CARCO_AMBIGUOUS","Une autre échéance de la même ligne est sans identifiant. Vérifier le groupe avant transmission.");
    if (
      binding &&
      (binding.article_code !== c.article_code ||
        (c.external_schedule_key &&
          c.external_schedule_key !== binding.schedule_key))
    ) {
      error(
        row,
        "CARCO_BINDING_CHANGED",
        "La référence ou l’échéance diffère de la correspondance ADV. Vérifier le rattachement.",
      );
    } else if (binding?.split && !c.external_schedule_key) {
      error(
        row,
        "CARCO_PREVIOUS_SPLIT",
        "Cette ligne a déjà eu plusieurs échéances. Identifiant d’échéance client nécessaire.",
      );
    } else if (
      !c.external_schedule_key &&
      binding &&
      c.kind === "FIRM" &&
      lineCounts.get(id) === 1
    ) {
      c.external_schedule_key = binding.schedule_key;
    }
    if (!c.external_schedule_key && (lineCounts.get(id) ?? 0) > 1)
      error(
        row,
        "CARCO_AMBIGUOUS",
        "Plusieurs échéances sur la même ligne. Identifiant d’échéance client nécessaire.",
      );
    const permitted = units.get(c.article_code ?? "");
    if (!c.unit && permitted?.size === 1) c.unit = Array.from(permitted)[0];
    if (!permitted && !exactCodes.has(c.article_code ?? ""))
      error(
        row,
        "CARCO_ARTICLE_UNKNOWN",
        "Article CRP à associer dans les correspondances article client.",
      );
    if (!c.unit && permitted && permitted.size > 1)
      error(
        row,
        "CARCO_UNIT_AMBIGUOUS",
        "Plusieurs unités client sont configurées pour cette référence.",
      );
    row.diagnostics = row.diagnostics.filter(
      (d) =>
        !(
          d.code === "REQUIRED_FIELD_MISSING" &&
          ((d.field === "unit" && c.unit) ||
            (d.field === "external_schedule_key" && c.external_schedule_key))
        ),
    );
  }
}
