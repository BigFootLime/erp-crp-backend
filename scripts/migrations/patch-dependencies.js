// Deployed filenames and checksums stay immutable. Dependencies take precedence
// over their historical filename order in every migration entry point.
const DEPENDENCIES = Object.freeze({
  "20260908_consultation_documents.sql": ["20260908_supplier_consultations.sql"],
  "20260909_consumable_procurement.sql": ["20260909_consumables.sql"],
  "20260909_grouped_supplier_receipts.sql": ["20260909_consumable_procurement.sql"],
  "20260909_consumable_need_reservations.sql": ["20260909_grouped_supplier_receipts.sql"],
  "20260909_consumable_of_revision.sql": ["20260909_consumable_need_reservations.sql"],
  "20260909_supply_terminals.sql": ["20260908_android_terminals_1038.sql"],
});

function orderPatchDependencies(filenames) {
  const present = new Set(filenames);
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(filename) {
    if (visited.has(filename)) return;
    if (visiting.has(filename)) throw new Error(`Cyclic migration dependency: ${filename}`);
    visiting.add(filename);
    for (const prerequisite of DEPENDENCIES[filename] ?? []) {
      // A selected inventory can rely on prerequisites already in the database.
      if (present.has(prerequisite)) visit(prerequisite);
    }
    visiting.delete(filename);
    visited.add(filename);
    ordered.push(filename);
  }
  filenames.forEach(visit);
  return ordered;
}

module.exports = { DEPENDENCIES, orderPatchDependencies };
