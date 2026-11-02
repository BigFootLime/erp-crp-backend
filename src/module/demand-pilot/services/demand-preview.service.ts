import type { DemandImportResult } from "../../demand-import/types";
import { HttpError } from "../../../utils/httpError";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import {
  assertDemandSiteAccess,
  resolveDemandRow,
} from "../repository/demand-pilot.repository";
import { demandRowSchema } from "../validators/demand-pilot.validators";
import { demandImportCompositeKey } from "../../demand-import/demand-import.adapter";

export async function qualifyDemandPreview(
  clientId: string,
  site: string,
  parsed: DemandImportResult,
  portalAccountId?: string,
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
        await resolveDemandRow(tx, clientId, parsedRow.data);
        const original = byKey.get(demandImportCompositeKey(parsedRow.data));
        if (original) valid.push(original);
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
      rows: valid,
      summary: {
        ...parsed.summary,
        valid: valid.length,
        invalid: parsed.preview_rows.filter((r) =>
          r.diagnostics.some((d) => d.level === "ERROR"),
        ).length,
      },
    };
  }, "REPEATABLE READ");
}
