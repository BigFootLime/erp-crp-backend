# Service preparation recovery

Apply after `20261007_purchase_preparations_902.sql` with the canonical migration runner. Run the matching preflight before stopping a runtime, verify after apply, then verify replay 0 and no pending/checksum mismatch. A verified fresh backup precedes production apply.

This patch extends a CHECK constraint only. It does not create supplier orders, reserve stock, migrate existing demand or send messages. Binary rollback retains the additive schema. Older runtimes query their own material/consumable kind and leave service history intact. The optional schema withdrawal refuses any service preparation or immutable event, including superseded preparations. Never delete history to make rollback succeed.

Service choices belong to one purchase source, technical hash/version, active OF revision and operation. On revision change a new demand identity is created; prior choices are not silently reused. Actual conforming quantities and material root distribution remain separately confirmed. Final supplier validation retains the existing predecessor, quantity, traceability and qualification checks.
