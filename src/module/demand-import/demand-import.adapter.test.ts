import { describe, expect, it } from "vitest";

import {
  compareDemandImportEpoch,
  demandImportCompositeKey,
  parseDemandImport,
} from "./demand-import.adapter";

describe("demand import adapter", () => {
  it("previews the historical Vision order table using its remaining balance and refuses ambiguous schedules", () => {
    const row = {ARTICLE:"DEMO", "Cde Order":"PO-1", UA:"PCE", QTE_CDE:"12", QTE_LIV:"5", QTE_SOLDE:"7",
      "Délai":"10/03/2027", ARC:"14/03/2027"};
    const blocked = parseDemandImport({source:"VISION_SYSTEMS", rows:[row]});
    expect(blocked.rows).toHaveLength(0);
    expect(blocked.preview_rows[0].candidate).toMatchObject({
      external_order_key:"PO-1", article_code:"DEMO", quantity:7, quantity_basis:"REMAINING", unit:"PCE",
    });
    expect(blocked.preview_rows[0].candidate.need_date).toBeUndefined();
    expect(blocked.preview_rows[0].candidate.source_confirmed_date).toBeUndefined();
    const qualified = parseDemandImport({source:"VISION_SYSTEMS", rows:[{...row, SITE:"PILOT", ID_LIGNE:"L", ID_ECHEANCE:"S",
      FERMETE:"FIRM", DATE_BESOIN:"14/03/2027", source_version:"W1", source_as_of:"2027-03-01T09:00:00Z"}]});
    expect(qualified.rows[0]).toMatchObject({quantity:7,quantity_basis:"REMAINING"});
  });
  it("maps an enriched generic row into the persistent canonical contract", () => {
    const result = parseDemandImport({
      source: "GENERIC",
      rows: [
        {
          external_site: "VS-FR",
          external_order_key: "PO-123",
          external_line_key: "10",
          external_schedule_key: "20",
          source_version: "r-0042",
          source_as_of: "2026-10-31T09:30:00+01:00",
          demand_kind: "FIRM",
          unit: "PCE",
          quantity: "12,5",
          need_date: "31/12/2026",
          article_code: "170-25298-000",
          contract_reference: "CONTRAT-1",
        },
      ],
    });
    expect(result.summary).toEqual({
      total: 1,
      valid: 1,
      invalid: 0,
      duplicate_composite_keys: 0,
    });
    expect(result.rows[0]).toMatchObject({
      kind: "FIRM",
      quantity: 12.5,
      need_date: "2026-12-31",
      source_as_of: "2026-10-31T08:30:00.000Z",
    });
  });

  it("turns the incomplete Vision Systems sample shape into actionable diagnostics without guessing", () => {
    const result = parseDemandImport({
      source: "VISION_SYSTEMS",
      rows: [
        {
          ARTICLE: "170-25298-000",
          NUM_CDE: "2700072",
          TYPE_CDE: "Cde Fermee",
          DATE_BESOIN: "31/12/9000",
        },
      ],
    });
    expect(result.rows).toHaveLength(0);
    expect(result.summary.invalid).toBe(1);
    expect(
      result.preview_rows[0].diagnostics.map((item) => item.code),
    ).toContain("SENTINEL_DATE_REQUIRES_REVIEW");
    expect(
      result.diagnostics.find(
        (item) => item.code === "VISION_SYSTEMS_ENRICHMENT_REQUIRED",
      )?.count,
    ).toBe(1);
  });

  it("rejects duplicate external composite keys and accepts no implicit deletion", () => {
    const base = {
      external_site: "VS-FR",
      external_order_key: "PO-123",
      external_line_key: "10",
      external_schedule_key: "20",
      source_version: "r-0042",
      source_as_of: "2026-10-31T08:30:00Z",
      kind: "FORECAST",
      unit: "PCE",
      article_code: "TEST-1",
      quantity: 1,
      need_date: "2026-12-31",
    };
    const result = parseDemandImport({ source: "GENERIC", rows: [base, base] });
    expect(result.rows).toHaveLength(0);
    expect(result.summary.duplicate_composite_keys).toBe(2);
    expect(
      result.preview_rows.every((row) =>
        row.diagnostics.some((item) => item.code === "DUPLICATE_COMPOSITE_KEY"),
      ),
    ).toBe(true);
  });

  it("uses timestamp then opaque version as a stable epoch comparator", () => {
    expect(
      compareDemandImportEpoch(
        { source_as_of: "2026-10-31T08:00:00.000Z", source_version: "z" },
        { source_as_of: "2026-10-31T09:00:00.000Z", source_version: "a" },
      ),
    ).toBeLessThan(0);
    expect(
      compareDemandImportEpoch(
        { source_as_of: "2026-10-31T09:00:00.000Z", source_version: "a" },
        { source_as_of: "2026-10-31T09:00:00.000Z", source_version: "z" },
      ),
    ).toBeLessThan(0);
    expect(
      demandImportCompositeKey({
        external_site: "A|B",
        external_order_key: "C",
        external_line_key: "D",
        external_schedule_key: "E",
      }),
    ).toBe("3:A|B|1:C|1:D|1:E");
  });
});
