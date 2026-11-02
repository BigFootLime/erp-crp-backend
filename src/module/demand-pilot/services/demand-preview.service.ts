import type { DemandImportResult } from "../../demand-import/types";
import { HttpError } from "../../../utils/httpError";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import {
  assertDemandSiteAccess,
  resolveDemandRow,
} from "../repository/demand-pilot.repository";
import { demandRowSchema } from "../validators/demand-pilot.validators";
import { demandImportCompositeKey } from "../../demand-import/demand-import.adapter";
import { qualifyCarcoReferences } from "./carco-qualification";

export async function qualifyDemandPreview(
  clientId: string,
  site: string,
  parsed: DemandImportResult,
  portalAccountId?: string,
  carco = false,
) {
  if (parsed.summary.total > 5000)
    throw new HttpError(
      413,
      "PILOT_BATCH_LIMIT",
      "Fractionnez le relevé en lots de 5 000 échéances au plus.",
    );
  return industrialTx(async (tx) => {
    if (portalAccountId)
      await assertDemandSiteAccess(tx, clientId, portalAccountId, site);
    if (carco) await qualifyCarcoReferences(tx, clientId, site, parsed);
    const byKey = new Map(
      parsed.rows.map((row) => [demandImportCompositeKey(row), row]),
    );
    const valid: DemandImportResult["rows"] = [];
    for (const preview of parsed.preview_rows) {
      if (preview.diagnostics.some((d) => d.level === "ERROR")) continue;
      const parsedRow = demandRowSchema.safeParse(preview.candidate);
      try {
        if (!parsedRow.success)
          throw new HttpError(
            422,
            "DEMAND_ROW_INVALID",
            parsedRow.error.issues
              .map((i) => i.path.join(".") + " : " + i.message)
              .join(" · "),
          );
        if (parsedRow.data.external_site !== site)
          throw new HttpError(
            422,
            "PILOT_SITE_MISMATCH",
            "Site différent du site choisi pour ce fichier.",
          );
        const resolved=await resolveDemandRow(tx, clientId, parsedRow.data);
        if (carco && !portalAccountId && resolved.article_id && resolved.article_code) {
          preview.resolved={article_id:resolved.article_id,article_code:resolved.article_code,quantity:resolved.quantity,
            unit:resolved.unit,contract_line_id:resolved.contract_line_id??null};
        }
        const original = carco ? parsedRow.data : byKey.get(demandImportCompositeKey(parsedRow.data));
        if (original) valid.push({...preview.candidate, ...original, article_code: original.article_code ?? undefined,
          customer_reference: original.customer_reference ?? undefined, contract_reference: original.contract_reference ?? undefined,
          comment: original.comment ?? undefined, source_requested_date: original.source_requested_date});
      } catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        const issue = {
          level: "ERROR" as const,
          code: e.code,
          field: null,
          row_number: preview.row_number,
          message: e.message,
        };
        preview.diagnostics.push(issue);
        parsed.diagnostics.push(issue);
      }
    }
    return {
      ...parsed,
      diagnostics: [...parsed.preview_rows.flatMap(row => row.diagnostics),
        ...parsed.diagnostics.filter(d=>d.row_number===undefined && d.level!=="ERROR" && valid.length<parsed.summary.total)],
      rows: valid,
      summary: {
        ...parsed.summary,
        duplicate_composite_keys: parsed.preview_rows.filter(r=>r.diagnostics.some(d=>d.code==="DUPLICATE_COMPOSITE_KEY")).length,
        valid: valid.length,
        invalid: parsed.preview_rows.filter((r) =>
          r.diagnostics.some((d) => d.level === "ERROR"),
        ).length,
      },
    };
  }, "REPEATABLE READ");
}
