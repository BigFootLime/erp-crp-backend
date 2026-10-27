import { describe, expect, it } from "vitest";
import { metrologyAdditionalFieldsSchema, metrologyControlSchema } from "./metrology-control-schema";

describe("source form capture", () => {
  it("preserves zero, false, empty text and missing values as distinct facts", () => {
    const fields = [
      { key: "measure", label: "Mesure", value_kind: "number", value: 0 },
      { key: "maintenance", label: "Entretien", value_kind: "boolean", value: false },
      { key: "comment", label: "Observation", value_kind: "text", value: "" },
      { key: "unknown", label: "Valeur inconnue", value_kind: "number", value: null },
    ];
    expect(metrologyAdditionalFieldsSchema.parse(fields)).toEqual(fields);
  });

  it.each([
    ["date", "2025-02-29"], ["date", "31/12/2025"], ["number", "25,01"],
    ["number", Infinity], ["boolean", "false"], ["text", 12],
  ])("rejects invalid %s values", (kind, value) => {
    expect(metrologyAdditionalFieldsSchema.safeParse([
      { key: "value", label: "Valeur", value_kind: kind, value },
    ]).success).toBe(false);
  });

  it("preserves qualifiers and source units without deriving a verdict", () => {
    const [field] = metrologyAdditionalFieldsSchema.parse([
      { key: "point_1", label: "Extrémité des becs", value_kind: "text", unit: "mm", value: "25,01 — à surveiller" },
    ]);
    expect(field.value).toBe("25,01 — à surveiller");
    expect(field).not.toHaveProperty("verdict");
  });

  it("rejects duplicate or unbounded field definitions", () => {
    const field = { key: "point", label: "Point", value_kind: "number" };
    expect(metrologyControlSchema.safeParse({ version: 1, fields: [field, field] }).success).toBe(false);
    expect(metrologyControlSchema.safeParse({ version: 1, fields: [{ ...field, key: "../path" }] }).success).toBe(false);
    expect(metrologyControlSchema.safeParse({ version: 1, fields: Array(101).fill(field) }).success).toBe(false);
  });
});
