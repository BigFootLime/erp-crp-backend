# Metrology measurement persistence — #1073

Recipe WP-285 found a real HTTP 500 on Test while saving three measurements in MEX-2026-001224. PostgreSQL returned P0001; the canonical #229 revision trigger rejected a second update of each freshly inserted measurement. The transaction rolled back, so no reading was committed.

The repository now computes each point verdict and deviation before its INSERT or motivated correction UPDATE. Value, verdict and deviation are written together. Initial points retain revision 1; a correction increments it once and stores previous values and its reason in the append-only history. No SQL trigger, permission, idempotency rule or validation is changed. The aggregate preview still computes the complete execution verdict, including the plan's minimum point count.

Regression command:

```sh
node node_modules/vitest/vitest.mjs run src/__tests__/metrology-measurement-revision-1073.test.ts src/__tests__/metrologie-360-229.domain.test.ts src/__tests__/metrologie-360-229.routes.test.ts
```

Before correction: both initial persistence and motivated correction fail under the canonical trigger contract; the other three guards pass. After correction: all 120 targeted repository, domain and route tests pass locally. Build of the immutable feature commit and browser replay after deployment remain mandatory.

Browser acceptance: reopen the Test execution without losing its pending readings; save 0/50/100 mm with absolute acceptance bounds ±0.03 around each nominal. Verify saved revision 1, CONFORME verdicts and zero deviations. Add the clearly synthetic metrology evidence and follow the actual qualification flow. Do not bypass required certificates or qualify a real industrial instrument from recipe evidence. Replay and shipment quality acceptance are tracked separately in the recipe journal; the global ERP recipe remains in progress.

No migration is required. Rollback consists of restoring the previous immutable backend artifact. New readings committed by the fix remain retained as audit evidence.
