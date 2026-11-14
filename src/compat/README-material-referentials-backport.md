# Material referentials backport

Mount `materialReferentialsBackportRouter` at `/stock` after company context and before the legacy Stock access gate. Mount `augmentMaterialReferentialsAccessProfile` under `/auth` immediately before the existing auth router. This temporary adapter exposes only the three material referentials.

## Lifecycle contract

The adapter is **RETAINED** because the captured EC assembly contains `dist/compat/material-referentials-backport.js` and the recorded EC material acceptance parsed it while passing 31 assertions. Its archived `dist/config/app.js` has no static require edge to this file, and no composite mount was located in the archive. Retention is mandated by the audited deployment documentation and user instruction until a reviewed target-runtime manifest resolves that boundary. Native routes in another source assembly do not by themselves retire that dependency claim.

Retention is recorded by `docs/compat/material-referentials-backport.lifecycle.json` and enforced by `scripts/compat/check-material-referentials-backport-lifecycle.mjs` during every build. The guard accepts only `RETAINED`; retirement needs a future reviewed change identifying the native replacement, exact source pair, target-runtime manifest and authenticated acceptance without this adapter.

For the Nuances-only 2.0.85 hotfix, the adapter supports the same four standard fields and primary-title rule as native Stock through `module/stock/domain/nuance-library`. Overlay only the adapter and that new helper in EC; preserve its older Stock repository, router mounts, auth/company middleware and all existing grants. The migration must precede activation. Code-only new nuances are rejected, while historical identities remain LEGACY until explicitly classified. Native CRP/VPS instead receive their own repository/validator/helper overlay.
