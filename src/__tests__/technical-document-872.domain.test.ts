import test from "node:test";
import assert from "node:assert/strict";
import { buildTechnicalSheet } from "../module/pieces-techniques/domain/technical-sheet";
import { buildOfTraveler } from "../module/production/domain/of-traveler";
import { currentDocumentSource } from "../shared/authoritative-documents/current-document.repository";

const definition = {
  piece: { code: "PT-01", designation: "Support", critical: true },
  version: {
    id: "selected-version",
    indice: "B",
    version_interne: 2,
    statut: "APPLICABLE",
  },
  operations: [
    {
      phase: 20,
      designation: "Tournage",
      reglage_h: 2,
      piece_h: 0.1,
      base_qty: 1,
      cout_mo: 500,
    },
  ],
  achats: [{ type: "MATIERE", qty: 10, pu_achat: 42 }],
};

test("technical sheet records the selected version and distinct setup/piece times without financial data", () => {
  const sheet = buildTechnicalSheet(definition),
    json = JSON.stringify(sheet);
  assert.ok(json.includes("selected-version"));
  assert.ok(!json.includes("pu_achat") && !json.includes("cout_mo"));
  const operation = sheet.sections.find((s) => s.title.startsWith("Gamme"))!
    .table!.rows[0];
  assert.equal(operation.tr, "2");
  assert.equal(operation.tp, "0.1");
});
test("editing a child operation changes the PDF source hash even if the parent timestamp is unchanged", () => {
  const before = currentDocumentSource(buildTechnicalSheet(definition));
  const after = currentDocumentSource(
    buildTechnicalSheet({
      ...definition,
      operations: [{ ...definition.operations[0], piece_h: 0.2 }],
    }),
  );
  assert.notEqual(before.sourceRevision, after.sourceRevision);
});
test("missing signatures and per-lot yield are never invented in the traveler", () => {
  const sheet = buildOfTraveler({
    of: { numero: "OF-01", indice: "A", version: 1, status: "EN_COURS" },
    debits: [{ id: "debit", phase: 10, good: 40, kind: "POTENTIAL_PIECES" }],
    cuts: [
      { debit_id: "debit", lot: "MP-A", cut: 1000, unit: "mm" },
      { debit_id: "debit", lot: "MP-B", cut: 800, unit: "mm" },
    ],
  });
  assert.equal(
    sheet.summary.find((r) => r.label === "Indice client")?.value,
    "A",
  );
  assert.equal(
    sheet.sections.find((s) => s.title.startsWith("Visas"))!.table!.rows.length,
    0,
  );
  const cuts = sheet.sections.find((s) =>
    s.title.startsWith("Sorties matière"),
  )!.table!.rows;
  assert.equal(cuts[0].cut, "1000");
  assert.equal(cuts[1].cut, "800");
  assert.ok(!Object.hasOwn(cuts[0], "good"));
});
test("oversized technical records fail explicitly rather than silently dropping document sections", () => {
  assert.throws(
    () =>
      buildTechnicalSheet({
        ...definition,
        operations: Array.from({ length: 251 }, (_, phase) => ({
          phase,
          consignes: "Consigne",
        })),
      }),
    /format d’édition/,
  );
});
