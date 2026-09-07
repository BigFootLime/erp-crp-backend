# OF stock and central planning recipe fixes (#764)

Manual recipe on 7 September 2026 exposed two broken links: the receipt context selected the nonexistent `pieces_techniques.code` column, and central simulation application wrote planning events without invoking the coordinate synchronization used by legacy planning. After drag-out and automatic replacement, the OF retained an empty machine assignment.

The receipt query now reads `code_piece`. Central application invokes the existing `syncPlanningCoordinates` in the same transaction after each operation event write. Resource qualification, revision checks, idempotency, launch status, quality and quantity ownership are unchanged. This does not release production or convert forecasts into physical inventory.

Validation before deployment: TypeScript passed; 44 existing targeted tests passed (central scheduler, resource qualification, production receipt allocations); `git diff --check` passed. Manual post-deployment acceptance: open OF Stock without 500, withdraw and replace a scheduled operation, then verify its machine and dates in the OF workspace. These UI results are recorded in the recipe journal; they are not asserted by the unit suite.

Deployment follows branch → dev → main, then Coolify and the two HYPERBOX2 API services. No schema or business data migration. Rollback: restore the previous service override saved by the release switch, or deploy the preceding commit. Existing planning events remain the source of truth.
