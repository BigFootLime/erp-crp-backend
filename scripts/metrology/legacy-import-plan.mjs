import { businessSourceFiles, refuse, relativeSourceName, sha256 } from "./legacy-import-files.mjs";

const profileCodes = new Set(["PC", "JP", "ME", "MI", "MES", "BF", "BL", "CA", "OUT", "TF", "TFD", "TLD"]);
const profileCategories = {
  PC: "PIED_A_COULISSE", JP: "CALIBRE", ME: "MICROMETRE", MI: "MICROMETRE", MES: "MACHINE_MESURE",
  BF: "CALIBRE", BL: "CALIBRE", CA: "ETALON", OUT: "AUTRE", TF: "CALIBRE", TFD: "CALIBRE", TLD: "CALIBRE",
};
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const textOrNull = value => value == null ? null : String(value);
const isoDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const uniqueMap = (items, key) => {
  const map = new Map();
  for (const item of items) {
    const id = key(item);
    if (!id || map.has(id)) refuse("duplicate or missing semantic identity");
    map.set(id, item);
  }
  return map;
};

/** Source artifacts stay untouched. Only the separately reviewed sidecar projects UI metadata. */
export function buildLegacyImportPlan(manifest, semantics) {
  if (!manifest.parserVersion?.startsWith("metrology-reconciliation/3.0.0") ||
      semantics.version !== 1 || !Array.isArray(semantics.groups) ||
      !Array.isArray(semantics.historyAnnotations) || !Array.isArray(semantics.sourceBindings) ||
      !Array.isArray(semantics.attachmentAssociations) || !Array.isArray(manifest.equipmentGroups) ||
      !Array.isArray(manifest.historyRows) || !Array.isArray(manifest.rawSourceSheets)) {
    refuse("reviewed complete manifest and semantic sidecar required");
  }
  const files = businessSourceFiles(manifest);
  const sources = uniqueMap(files, file => file.relativePath);
  const semanticGroups = uniqueMap(semantics.groups, group => group.groupId);
  const annotations = uniqueMap(semantics.historyAnnotations, row => row.historyId);
  if (semanticGroups.size !== manifest.equipmentGroups.length || annotations.size !== manifest.historyRows.length) {
    refuse("semantic coverage differs from source groups or histories");
  }
  const groups = uniqueMap(manifest.equipmentGroups, group => group.groupId);
  const attachmentBindings = uniqueMap(semantics.attachmentAssociations, item => relativeSourceName(item.sourceRelativePath));
  const sheetBindings = new Map();
  const rowBindings = new Map();
  const sheetKey = (name, sheet) => relativeSourceName(name) + "\0" + sheet;
  for (const binding of semantics.sourceBindings) {
    if (!groups.has(binding.equipmentGroupId)) refuse("unknown source binding group");
    const key = sheetKey(binding.sourceRelativePath, binding.sheetName);
    if (!sheetBindings.has(key)) sheetBindings.set(key, new Set());
    sheetBindings.get(key).add(binding.equipmentGroupId);
  }
  for (const group of manifest.equipmentGroups) {
    for (const fact of group.sourceFacts ?? []) {
      if (fact.sourceRelativePath && fact.sheet && Number.isInteger(fact.row)) {
        rowBindings.set(sheetKey(fact.sourceRelativePath, fact.sheet) + "\0" + fact.row, group.groupId);
      }
    }
  }
  function boundGroup(name, sheet, row) {
    const key = sheetKey(name, sheet);
    const exact = rowBindings.get(key + "\0" + row);
    if (exact) return exact;
    const matches = sheetBindings.get(key);
    return matches?.size === 1 ? [...matches][0] : null;
  }
  const records = [];
  function add({ source, sheet, coordinate, key = null, raw, normalized, disposition = "PENDING", diagnostics = [] }) {
    const name = relativeSourceName(source);
    if (!sources.has(name)) refuse("record refers to a source absent from inventory");
    if (!object(raw) || !object(normalized)) refuse("captured facts must be JSON objects");
    const record = { source: name, sheet: String(sheet), coordinate: String(coordinate), key, raw, normalized, disposition, diagnostics };
    records.push({ ...record, sha256: sha256(JSON.stringify(record)) });
  }
  for (const group of manifest.equipmentGroups) {
    const semantic = semanticGroups.get(group.groupId);
    const code = group.observedCodeVerbatim;
    if (semantic.code !== code || typeof code !== "string" || !code.trim()) refuse("semantic code differs from literal source code");
    if (!["registry-apparatus", "source-card-apparatus"].includes(group.groupKind)) refuse("unsupported apparatus evidence");
    const registry = group.groupKind === "registry-apparatus";
    const literalDatedRegistryCode = registry && /^CA-\d{2}-(?:0[1-9]|1[0-2])[-/](?:19|20)\d{2}$/.test(code);
    if (registry && code !== group.registryEvidence?.COCONTR) refuse("registry code must equal COCONTR, never IDCONTROLE");
    if (!/^[A-Z]{2,8}-[0-9]{2,6}$/.test(code) && !literalDatedRegistryCode) refuse("unproved equipment code format");
    const profile = code.split("-")[0];
    if (!profileCodes.has(profile)) refuse("unknown equipment profile");
    const projection = semantic.registry_fiche_projection;
    const historique = registry ? projection?.historique : {};
    if (!object(historique)) refuse("reviewed registry UI projection missing");
    const sourceControlSchema = semantic.control_schema ?? null;
    const controlSchema = sourceControlSchema ? {
      version: sourceControlSchema.version,
      fields: sourceControlSchema.fields?.map(({ key, label, value_kind, unit, required }) => ({
        key, label, value_kind, ...(unit !== undefined ? { unit } : {}), ...(required !== undefined ? { required } : {}),
      })),
    } : null;
    if (controlSchema && (controlSchema.version !== 1 || !Array.isArray(controlSchema.fields) || controlSchema.fields.length > 100)) {
      refuse("invalid contextual control schema");
    }
    const firstFact = (group.sourceFacts ?? []).find(fact => fact.sourceRelativePath);
    const source = registry ? manifest.registrySource.relativePath : firstFact?.sourceRelativePath;
    const file = sources.get(relativeSourceName(source));
    const assertedHash = registry ? manifest.registrySource.sha256 : firstFact.sourceFileSha256 ?? firstFact.sourceSha256;
    if (file.sha256 !== assertedHash) refuse("apparatus evidence source digest mismatch");
    const designation = semantic.designation ?? group.registryEvidence?.DESA1;
    if (typeof designation !== "string" || !designation.trim()) refuse("source-backed apparatus designation required");
    add({
      source, sheet: firstFact?.sheet ?? "SOURCE_CARD", coordinate: "equipment:" + group.groupId, key: group.groupId,
      raw: { registry_evidence: group.registryEvidence ?? {}, registry_row: group.registryRow ?? null, source_facts: group.sourceFacts },
      normalized: {
        record_kind: "equipment", group_id: group.groupId, group_kind: group.groupKind, observed_code_verbatim: code,
        categorie_code: profileCategories[profile],
        identity_status: literalDatedRegistryCode ? "legacy-dated-code" : registry ? "exact" : "folder-only",
        source_identity_status: group.identityStatus, designation, registry_evidence: group.registryEvidence ?? {},
        marque: textOrNull(group.registryEvidence?.MARQU), numero_serie: textOrNull(group.registryEvidence?.NUMSERIE),
        source_facts: group.sourceFacts, designation_provenance: semantic.designation_provenance ?? null,
        control_schema_provenance: sourceControlSchema,
        fiche_metrologie: { version: 1, profile_code: profile, historique, control_schema: controlSchema },
      },
    });
  }
  for (const history of manifest.historyRows) {
    if (sources.get(relativeSourceName(history.sourceRelativePath))?.sha256 !== history.sourceFileSha256) refuse("history source digest mismatch");
    const annotation = annotations.get(history.historyId);
    if (!["history", "source-row"].includes(annotation.recordKind) ||
        (annotation.observed_on != null && !isoDate(annotation.observed_on))) refuse("invalid reviewed observation projection");
    const groupId = history.equipmentGroupId ?? null;
    if (groupId && !groups.has(groupId)) refuse("unknown history group");
    const actualHistory = annotation.recordKind === "history";
    add({
      source: history.sourceRelativePath, sheet: history.sheetName, coordinate: "history:" + history.historyId,
      key: groupId, raw: { fields: history.fields, source_row: history.rowNumber, block_header_row: history.blockHeaderRow },
      normalized: {
        record_kind: annotation.recordKind, ...(actualHistory ? { history_id: history.historyId } : { rejected_history_candidate: history.historyId }),
        equipment_group_id: groupId, identity_attachment: history.identityAttachment,
        observed_on: annotation.observed_on, observed_date_raw: annotation.observed_date_raw,
        legacy_visa_text: annotation.legacy_visa_text, legacy_verdict_text: annotation.legacy_verdict_text,
      },
      disposition: actualHistory ? groupId ? "PENDING" : "AMBIGUOUS" : "SKIPPED",
      diagnostics: annotation.diagnostics ?? [],
    });
  }
  for (const sheet of manifest.rawSourceSheets) {
    if (sources.get(relativeSourceName(sheet.sourceRelativePath))?.sha256 !== sheet.sourceFileSha256) refuse("raw sheet source digest mismatch");
    const { rows, ...metadata } = sheet;
    add({
      source: sheet.sourceRelativePath, sheet: sheet.sheetName, coordinate: "sheet-metadata",
      raw: metadata, normalized: { record_kind: "source-row", raw_sheet_snapshot: true, evidence_only: true },
      disposition: "SKIPPED",
    });
    for (const row of rows ?? []) {
      const groupId = boundGroup(sheet.sourceRelativePath, sheet.sheetName, row.rowNumber);
      add({
        source: sheet.sourceRelativePath, sheet: sheet.sheetName, coordinate: "row:" + row.rowNumber,
        key: groupId, raw: row,
        normalized: { record_kind: "source-row", equipment_group_id: groupId, evidence_only: true },
        disposition: "SKIPPED",
      });
    }
  }
  for (const attachment of manifest.attachments.business) {
    const name = relativeSourceName(attachment.sourceRelativePath);
    const binding = attachmentBindings.get(name);
    if (!binding) refuse("attachment lacks an explicit review disposition");
    const groupId = binding.groupId ?? null;
    if (groupId && !groups.has(groupId)) refuse("unknown attachment target");
    add({
      source: name, sheet: "DOCUMENT", coordinate: "attachment", key: groupId,
      raw: { source: attachment, archive_entries: (manifest.attachments.archiveEntries ?? []).filter(entry => relativeSourceName(entry.archiveRelativePath) === name) },
      normalized: { record_kind: "attachment", equipment_group_id: groupId, identity_attachment: binding.status },
      disposition: groupId ? "PENDING" : "AMBIGUOUS",
    });
  }
  for (const cell of manifest.supplementalRawEvidence?.records ?? []) {
    if (sources.get(relativeSourceName(cell.sourceRelativePath))?.sha256 !== cell.sourceFileSha256) refuse("supplemental source digest mismatch");
    const groupId = boundGroup(cell.sourceRelativePath, cell.sheetName, cell.rowNumber);
    add({
      source: cell.sourceRelativePath, sheet: cell.sheetName, coordinate: "supplemental-book:" + cell.address,
      key: groupId, raw: cell,
      normalized: { record_kind: "source-row", equipment_group_id: groupId, evidence_only: true,
        parser_evidence: "book-parser-address-not-represented-in-normalized-rawSourceSheets" },
      disposition: "SKIPPED",
    });
  }
  for (const review of semantics.legacyRegistryReview ?? []) {
    add({
      source: review.sourceRelativePath, sheet: review.sheetName, coordinate: "legacy-registry-review:" + review.rowNumber,
      raw: review, normalized: { record_kind: "source-row", legacy_registry_review: true, observed_code_verbatim: review.code },
      disposition: "AMBIGUOUS", diagnostics: ["OLDER_REGISTRY_CODE_ABSENT_FROM_PRIMARY_REGISTRY"],
    });
  }
  const summary = {
    sources: files.length, equipment: groups.size,
    history_candidates: manifest.historyRows.length,
    observations: records.filter(record => record.normalized.record_kind === "history").length,
    history_unresolved: records.filter(record => record.normalized.record_kind === "history" && !record.normalized.equipment_group_id).length,
    evidence_rows: records.length, raw_sheets: manifest.rawSourceSheets.length,
    raw_stored_cells: manifest.rawSourceSheets.reduce((sum, sheet) => sum + (sheet.rows ?? []).reduce((n, row) => n + (row.cells?.length ?? 0), 0), 0),
    attachments: manifest.attachments.business.length,
    attachments_unresolved: records.filter(record => record.normalized.record_kind === "attachment" && !record.normalized.equipment_group_id).length,
    technical_exclusions: manifest.attachments.excluded?.length ?? 0,
    archive_members: manifest.attachments.archiveEntries?.length ?? 0,
    supplemental_raw_cells: manifest.supplementalRawEvidence?.records?.length ?? 0,
  };
  return { files, records, summary };
}
