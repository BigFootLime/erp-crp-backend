import { describe, expect, it } from "vitest";

import { listFacturesQuerySchema } from "../validators/factures.validators";
import { buildListWhere } from "./factures.repository";

describe("#469 invoice list historical filters", () => {
  it("filters unknown historical rows through document_status=LEGACY", () => {
    const filters = listFacturesQuerySchema.parse({ statut: "LEGACY" });
    expect(buildListWhere(filters, false)).toEqual({
      whereSql: "WHERE f.document_status = 'LEGACY'",
      values: [],
    });
  });

  it("filters a supported historical value through the untouched legacy projection", () => {
    const filters = listFacturesQuerySchema.parse({ statut: "emise" });
    const built = buildListWhere(filters, false);
    expect(built.whereSql).toBe("WHERE f.statut = $1");
    expect(built.values).toEqual(["emise"]);
  });

  it.each(["DRAFT", "CANCELLED"] as const)(
    "filters canonical %s rows through document_status",
    (status) => {
      const filters = listFacturesQuerySchema.parse({ statut: status });
      const built = buildListWhere(filters, false);
      expect(built.whereSql).toBe("WHERE f.document_status = $1");
      expect(built.values).toEqual([status]);
    }
  );
});
