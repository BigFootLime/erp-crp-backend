# Material referentials backport

Mount `materialReferentialsBackportRouter` at `/stock` after company context and before the legacy Stock access gate. Mount `augmentMaterialReferentialsAccessProfile` under `/auth` immediately before the existing auth router. This temporary adapter exposes only the three material referentials and must be removed when the target runtime carries their native routes.
