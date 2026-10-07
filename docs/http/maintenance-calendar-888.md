# Maintenance calendar API

All routes require ERP authentication. Read: `machine.read`. Preview/publish: `machine.availability` and maintenance-manager role policy.

- GET `/production/maintenance-calendar`: machines, active providers/users/plans, versioned definitions, history counts, Paris clock and `can_manage`.
- POST `/production/maintenance-calendar/preview`: `{schedule_id:null|uuid, expected_version:null|int, definition, reason}`. Returns an immutable comparison/hash, reservations/cancellations, preserved/covered slots and conflicts.
- POST `/production/maintenance-calendar/publish`: `{proposal, preview_hash}`, `Idempotency-Key: uuid`. Canonical command receipt replays the exact result for the same authenticated actor/input.

Definition kinds: `LEVEL_1_WEEKLY` (date period up to 366 days, ISO weekday, HH:mm, duration, machine targets) and `LEVEL_2_ANNUAL` (year, one entry per machine with local date/time, INTERNAL/EXTERNAL, provider required when external). Optional plan must belong to the machine; assignee must be active and is internal only.

Disable: existing schedule/version with `definition:null`. Reactivation supplies its definition with the expected current version. Kind cannot change; make a distinct rule instead. New rules cannot begin in the past. All validation is strict; no extra fields are accepted.

409 `MAINTENANCE_PREVIEW_STALE`: refresh the preview; 409 `MAINTENANCE_SCHEDULE_CONFLICT`: resolve the occupied machine explicitly; 422: repair the invalid references/date/input. An uncertain transport/commit result must use the exact same publish payload/key. A role or module grant never bypasses the maintenance-manager check.

Migration: `20261007_maintenance_schedule_888.sql`, additive, no seeded bookings. Support preflight/verify/rollback rehearsal/recovery accompanies it.
