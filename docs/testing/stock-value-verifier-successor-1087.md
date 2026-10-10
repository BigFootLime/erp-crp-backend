# Stock valuation verification after #1022

Issue #1087, 2026-10-10. Native candidate frontend 4af8ba5c / backend 4ad0cd18
passes frontend/backend suites, builds, bundle budgets and migration inventory,
then fails in the disposable rehearsal: #1007's verifier still requires the
constraint replaced by #1022. No production migration or native publication.

The verifier selects the expected key from the schema: six exact columns and
the #1007 name before invoice corrections exist; seven exact columns and the
#1022 name afterward. Both require a validated, ready, valid unique index with
`NULLS NOT DISTINCT`. The successor also requires the validated exact identity
binding `INVOICE_ADJUSTMENT` to a non-null invoice correction UUID.

The rehearsal tests seven transactional alterations: missing key, predecessor
key on successor schema, wrong columns with unchanged count, NULLS DISTINCT,
missing identity, weakened identity and NOT VALID identity. Each must fail
with the relevant verifier error; rollback restores the schema and the real
verifier must pass again. These mutations run only in the rehearsal's
disposable `cerp_test` database, never through the HTTP API or production.

No schema patch, runtime application file, route, permission or ledger hash is
changed. The branch starts from official dev including the already deployed
f212bf11 public-comment fix; its files remain untouched. Targeted rehearsal
and complete release qualification are pending.

Project Office `DESKTOP-MIGRATION-1087`: helper refused in dry-run before network
because its destination is unconfigured. No remote state or DONE claimed.
