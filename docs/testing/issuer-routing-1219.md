# Issuer routing qualification — #1219, WP285

Finance readiness previously ignored electronic routing and resolved legal mentions at January 1. It now uses today's applicable legal version and the same address/verification validation as invoice creation. Only the active policy's issuer blocks overall readiness; the selected year still scopes legal sequences.

Administrators with `settings_manage` can POST `/factures/configuration/issuers/:id/electronic-invoicing/verify` with `identifier`, `expected_updated_at` and an Idempotency-Key. The directory must confirm the exact active SIREN/address pair. No caller-supplied verification timestamp is accepted, no credentials are created and no invoice is sent. The existing append-only directory command ledger accepts `ISSUER` through one constraint extension.

Qualification is transactional with audit and an issuer advisory lock. A legal version predating today is closed today and copied into a new version, retaining its original future endpoint and legal values. A version created today may receive its first qualification, audited with its previous routing; an already qualified different address cannot overwrite that daily version. Identical qualified addresses and identical requests do not create duplicate versions. Historical invoice snapshots remain unchanged. Expired reference data or concurrent modification causes a refusal.

Tests cover missing/unverified addresses, current-date readiness, active-issuer scope, directory SIREN mismatches, inactive/absent entries, version copying, same-day qualification, replay and role restrictions. Schema preflight, verify and conservative rollback scripts accompany the migration. If issuer commands already exist, roll back application code and retain the additive constraint; do not erase traceability.

The S03 client SIREN999999998 is synthetic: its public directory query returned no entries. It must never be marked verified or transmitted. Passing unit tests and schema rehearsal do not qualify the BL56 invoice; normal UI creation, issue, PDF and duplicate checks remain required after deployment and valid reference configuration.

Live replay found a legacy SIREN formatted with spaces. Readiness, directory lookup and the locked identity comparison normalize display whitespace, including non-breaking spaces, without rewriting historical legal values. Three regression assertions failed before this correction and pass after it; different digits still cause a concurrency refusal.
