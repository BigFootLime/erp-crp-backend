// The closed-registry seed and its compatibility seed have immutable SQL and
// different valid historical GED profiles. A skipped closed seed is never
// written to the migration ledger: it is reported only when the Finance
// profile and the compatibility postcondition are proved exactly.
const CLOSED_SEED = "20261027_metrology_ged_entity_type_1780.sql";
const COMPAT_SEED = "20261027_metrology_ged_entity_type_1780_compat.sql";
const FINANCE_PROFILE = "20261014_finance_ged_profile_1268.sql";
const GED_CLEANUP = "20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql";
const SCAN_CLASS = "20261027_metrology_scan_documents_1780.sql";

function expectedChecksum(patches, filename) {
  const patch = patches.find((item) => item.filename === filename);
  if (!patch) throw new Error(`Metrology GED applicability inventory is missing ${filename}.`);
  return patch.sha256;
}

function ledgerMatches(applied, patches, filename) {
  const row = applied.get(filename);
  return Boolean(row && row.sha256 === expectedChecksum(patches, filename));
}

async function resolveClosedSeedApplicability(client, patches, applied) {
  const closed = patches.find((patch) => patch.filename === CLOSED_SEED);
  if (!closed || applied.has(CLOSED_SEED)) return new Map();
  // Before the compatibility seed is recorded this is an ordinary pending
  // closed seed, including source snapshots used by the rehearsal.
  if (!applied.has(COMPAT_SEED) || !applied.has(SCAN_CLASS)) return new Map();

  const state = await client.query(`
    SELECT
      to_regprocedure('public.fn_ged_link_guard()') IS NOT NULL AS closed_guard_present,
      to_regclass('public.ged_entity_types') IS NOT NULL AS entity_catalog_present,
      to_regclass('public.ged_document_classes') IS NOT NULL AS class_catalog_present,
      to_regclass('public.metrologie_equipements') IS NOT NULL AS equipment_catalog_present,
      EXISTS (
        SELECT 1 FROM public.ged_entity_types
        WHERE entity_type='METROLOGIE_EQUIPEMENT'
          AND label='Équipement de métrologie'
          AND module_key='metrologie'
          AND target_table='metrologie_equipements'
          AND target_pk_column='id'
          AND sort_order=115 AND is_active
      ) AS entity_value_exact,
      EXISTS (
        SELECT 1 FROM public.ged_document_classes
        WHERE class_key='METROLOGIE_SCAN' AND domain='QUALITE'
          AND label='Document et scan instrument' AND nature='EVIDENCE'
          AND allowed_mime_types=ARRAY['application/pdf','image/jpeg','image/png']::text[]
          AND allowed_extensions=ARRAY['.pdf','.jpg','.jpeg','.png']::text[]
          AND max_size_bytes=26214400 AND approvals_required=0
          AND retention_months=120 AND hold_on_publish
      ) AS class_value_exact
  `);
  const profile = state.rows[0];
  if (profile?.closed_guard_present) return new Map();

  const ledgerOk = [GED_CLEANUP, FINANCE_PROFILE, SCAN_CLASS, COMPAT_SEED]
    .every((filename) => ledgerMatches(applied, patches, filename));
  const valuesOk = profile?.entity_catalog_present && profile?.class_catalog_present
    && profile?.equipment_catalog_present && profile?.entity_value_exact && profile?.class_value_exact;
  if (!ledgerOk || !valuesOk) {
    throw new Error(
      `Refusing ${CLOSED_SEED}: fn_ged_link_guard is absent outside the exact Finance compatibility profile.`
    );
  }
  return new Map([[CLOSED_SEED, {
    status: "not-applicable-finance-profile",
    reason: "FINANCE_PROFILE_COMPAT_SUPERSEDES_CLOSED_SEED",
  }]]);
}

module.exports = { CLOSED_SEED, resolveClosedSeedApplicability };
