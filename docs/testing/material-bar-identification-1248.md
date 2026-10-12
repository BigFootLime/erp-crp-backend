# Physical material bar identification (#1248)

The additive migration assigns immutable identity numbers to physical bars and permits `STOCK_MATERIAL_BAR` in the existing identification protocol. It preserves all stock quantities, versions, reservations and material-lot relationships. A label's QR remains opaque; its descriptor exposes a `BAR-` code and the parent lot route. No shipping flow is added for material bars.

The cutting scanner accepts a lot or exact bar. Lot scans never guess between bars. Exact bar scans require confirmed physical geometry, a current reservation/hold belonging to the selected operation, the matching stock batch/material lot and usable lot status. Replayed scan events preserve the original timestamp only for the same actor; normal identification replay checks remain active and current holds are rechecked.

## Verification

Seventeen targeted domain/service tests passed. A full-schema ephemeral PostgreSQL clone validates migration/preflight/verify plus one integration case: distinct numbers on two bars, label creation replay, exact QR resolution replay, SVG rendering, identity protection against explicit assignment and DEFAULT, blocked-lot refusal. Eighteen unrelated suite cases are deliberately skipped. This is not a live deployment or full recipe validation.

That integration case revealed an existing matrix barcode error in `bwip-js`: omit the optional `height` property for QR/Data Matrix rather than passing `undefined`. Linear CODE_128 height is unchanged.

Use the patch's support preflight/verify/recovery files. Its rollback is intentionally conservative around identity evidence; normal recovery retains the additive schema and rolls back application code. Back up live databases before applying any patch. Frontend #1508 and native consumers must be aligned before release; physical printer/Android qualification remains pending.
