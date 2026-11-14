# Material referentials backport

Mount `materialReferentialsBackportRouter` at `/stock` after company context and before the legacy Stock access gate. Mount `augmentMaterialReferentialsAccessProfile` under `/auth` immediately before the existing auth router. This temporary adapter exposes only the three material referentials.

## Lifecycle contract

The adapter is **RETAINED** because the captured EC assembly contains `dist/compat/material-referentials-backport.js`, its captured `dist/routes/v1.routes.js` requires the module, mounts `augmentMaterialReferentialsAccessProfile` at `/auth`, then mounts `materialReferentialsBackportRouter` at `/stock` before the module-access gate. The recorded EC material acceptance parsed the adapter while passing 31 assertions. The current native source does not import or mount this adapter, but native routes in another source assembly do not retire the captured composite entrypoint.

`docs/compat/material-referentials-backport.lifecycle.json` records the complete static evidence and limits: the captured app uses `validationErrorMiddleware` and `errorHandler`; the legacy `error.middleware.ts` and `validate.ts` compiled members are present but have no static require edge in the captured EC assembly, and the current source imports neither. Presence is not activation proof. Keep all three candidates until a reviewed target-runtime manifest resolves external and operational entrypoints.

Retention is recorded by `docs/compat/material-referentials-backport.lifecycle.json` and enforced by `scripts/compat/check-material-referentials-backport-lifecycle.mjs` during every build. The guard accepts only `RETAINED`; retirement needs a future reviewed change identifying the native replacement, exact source pair, target-runtime manifest and authenticated acceptance without this adapter.

For the Nuances-only 2.0.85 hotfix, the adapter supports the same four standard fields and primary-title rule as native Stock through `module/stock/domain/nuance-library`. Overlay only the adapter and that new helper in EC; preserve its older Stock repository, router mounts, auth/company middleware and all existing grants. The migration must precede activation. Code-only new nuances are rejected, while historical identities remain LEGACY until explicitly classified. Native CRP/VPS instead receive their own repository/validator/helper overlay.
