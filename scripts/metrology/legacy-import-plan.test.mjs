import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildLegacyImportPlan } from "./legacy-import-plan.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const registryHash = hash("registry"), cardHash = hash("card"), pdfHash = hash("pdf");
function fixture() {
  const manifest = {
    parserVersion: "metrology-reconciliation/3.0.0+test",
    sourceSet: { files: [
      { relativePath: "Liste appareils de mesure.xlsx", sha256: registryHash, sizeBytes: 8 },
      { relativePath: "PC-53/MD15-PC-53.ods", sha256: cardHash, sizeBytes: 4 },
    ] },
    registrySource: { relativePath: "Liste appareils de mesure.xlsx", sha256: registryHash },
    equipmentGroups: [
      { groupId: "registry-1", groupKind: "registry-apparatus", observedCodeVerbatim: "PC-01", identityStatus: "exact-registry", registryRow: 4,
        registryEvidence: { COCONTR: "PC-01", IDCONTROLE: "not-the-code", DESA1: "Pied", NUMSERIE: "0007" }, sourceFacts: [] },
      { groupId: "card-1", groupKind: "source-card-apparatus", observedCodeVerbatim: "PC-53", identityStatus: "draft-source-card", registryEvidence: {},
        sourceFacts: [{ sourceRelativePath: "PC-53/MD15-PC-53.ods", sourceFileSha256: cardHash, sheet: "Feuille1", row: 2 }] },
    ],
    historyRows: [
      { historyId: "history-1", sourceRelativePath: "PC-53/MD15-PC-53.ods", sourceFileSha256: cardHash, sheetName: "Feuille1", rowNumber: 8, blockHeaderRow: 5, equipmentGroupId: "card-1", identityAttachment: "folder-file-agree", fields: [{ family: "date", rawValue: 45200 }, { family: "visa", displayedValue: "VISA-A" }] },
      { historyId: "candidate-2", sourceRelativePath: "PC-53/MD15-PC-53.ods", sourceFileSha256: cardHash, sheetName: "Feuille1", rowNumber: 9, blockHeaderRow: 5, equipmentGroupId: "card-1", identityAttachment: "folder-file-agree", fields: [{ family: "measurement", rawValue: 43.99 }] },
    ],
    rawSourceSheets: [{ sourceRelativePath: "PC-53/MD15-PC-53.ods", sourceFileSha256: cardHash, kind: "ods", sheetName: "Feuille1", sheetState: "visible", mergedRanges: ["A1:B1"], hiddenColumns: [], rows: [{ rowNumber: 2, cells: [{ address: "A2", value: "PC-53" }] }] }],
    attachments: { business: [{ sourceRelativePath: "PC-53/cert.pdf", sha256: pdfHash, bytes: 3 }], archiveEntries: [], excluded: [{ sourceRelativePath: "Thumbs.db", reason: "technical" }] },
  };
  const semantics = {
    version: 1,
    groups: [
      { groupId: "registry-1", code: "PC-01", designation: "Pied", control_schema: null, registry_fiche_projection: { version: 1, profile_code: "PC", historique: { COCONTR: "PC-01", NUMSERIE: "0007" } } },
      { groupId: "card-1", code: "PC-53", designation: "Pied spécial", designation_provenance: { address: "C2" }, control_schema: { version: 1, fields: [{ key: "mesure", label: "Mesure", value_kind: "text" }] } },
    ],
    sourceBindings: [{ sourceRelativePath: "PC-53/MD15-PC-53.ods", sheetName: "Feuille1", equipmentGroupId: "card-1", identityMethod: "folder-code-exact" }],
    historyAnnotations: [
      { historyId: "history-1", recordKind: "history", observed_on: "2023-10-01", observed_date_raw: "45200", legacy_visa_text: "VISA-A", legacy_verdict_text: null, diagnostics: [] },
      { historyId: "candidate-2", recordKind: "source-row", observed_on: null, observed_date_raw: "43.99", legacy_visa_text: null, legacy_verdict_text: null, diagnostics: ["NOT_A_DATE"] },
    ],
    attachmentAssociations: [{ sourceRelativePath: "PC-53/cert.pdf", groupId: null, status: "review" }],
    legacyRegistryReview: [],
  };
  return { manifest, semantics };
}

test("plan uses COCONTR, preserves raw history, and keeps non-history candidates as evidence", () => {
  const { manifest, semantics } = fixture();
  const plan = buildLegacyImportPlan(manifest, semantics);
  const registry = plan.records.find(row => row.normalized.record_kind === "equipment" && row.normalized.group_id === "registry-1");
  assert.equal(registry.normalized.observed_code_verbatim, "PC-01");
  assert.equal(registry.normalized.fiche_metrologie.historique.NUMSERIE, "0007");
  const history = plan.records.find(row => row.normalized.history_id === "history-1");
  assert.equal(history.normalized.observed_on, "2023-10-01");
  assert.deepEqual(history.raw.fields, manifest.historyRows[0].fields);
  const candidate = plan.records.find(row => row.normalized.rejected_history_candidate === "candidate-2");
  assert.equal(candidate.normalized.record_kind, "source-row");
  assert.equal(candidate.disposition, "SKIPPED");
  assert.equal(plan.summary.observations, 1);
  assert.equal(plan.summary.attachments_unresolved, 1);
});

test("plan retains sheet metadata and raw rows as object evidence", () => {
  const { manifest, semantics } = fixture();
  const plan = buildLegacyImportPlan(manifest, semantics);
  const metadata = plan.records.find(row => row.coordinate === "sheet-metadata");
  const row = plan.records.find(record => record.coordinate === "row:2");
  assert.equal(metadata.normalized.record_kind, "source-row");
  assert.deepEqual(metadata.raw.mergedRanges, ["A1:B1"]);
  assert.equal(row.normalized.equipment_group_id, "card-1");
  assert.deepEqual(row.raw.cells, [{ address: "A2", value: "PC-53" }]);
});

test("plan refuses a literal invalid date projection", () => {
  const { manifest, semantics } = fixture();
  semantics.historyAnnotations[0].observed_on = "2024-02-31";
  assert.throws(() => buildLegacyImportPlan(manifest, semantics), /invalid reviewed observation/);
});
