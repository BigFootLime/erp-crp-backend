# Material referentials backport

Mount `materialReferentialsBackportRouter` at `/stock` after company context and before the legacy Stock access gate. Mount `augmentMaterialReferentialsAccessProfile` under `/auth` immediately before the existing auth router. This temporary adapter exposes only the three material referentials and must be removed when the target runtime carries their native routes.

For the Nuances-only 2.0.85 hotfix, the adapter supports the same four standard fields and primary-title rule as native Stock through `module/stock/domain/nuance-library`. Overlay only the adapter and that new helper in EC; preserve its older Stock repository, router mounts, auth/company middleware and all existing grants. The migration must precede activation. Code-only new nuances are rejected, while historical identities remain LEGACY until explicitly classified. Native CRP/VPS instead receive their own repository/validator/helper overlay.
