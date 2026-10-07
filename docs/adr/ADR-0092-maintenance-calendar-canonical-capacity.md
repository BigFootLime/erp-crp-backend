# ADR-0092 — Maintenance calendar and canonical capacity

Status: accepted for issues #888 / frontend #1169, WP-280. Business acceptance pending the final combined recipe.

Weekly level 1 (Thursday, 60 minutes by default) and annual level 2 (seven local calendar days per machine) are explicit versioned definitions. The user supplies the actual start time, period, dates, provider and optional internal assignee/checklist. No calendar fixture is seeded by deployment.

Publication creates the existing `planning_events` / `production_machine_unavailability` pair and appends the existing machine-maintenance event. Central planning consumes this canonical capacity for machines and linked workstations. Resource snapshots expose the same event titles/descriptions so Gantt shows and explains maintenance reservations.

The additive schedule/revision/occurrence tables store configuration and provenance; they are not an alternate capacity or execution ledger. Revisions and occurrence snapshots are immutable. Current definitions use a monotonic version and a deferred FK to their revision. Each occurrence records its canonical availability, provider/intervenant/plan snapshot and source revision.

Preview reconciles all active definitions: future PLANNED generated slots may be replaced; past and started ones stay. A weekly slot fully contained in an annual week is represented by the annual reservation alone. Removing a future annual week restores the future weekly slot. Partial overlaps and existing OF/custom events are conflicts, with no automatic OF movement. Europe/Paris civil dates are expanded by PostgreSQL; nonexistent or ambiguous local clock times require another time.

Publication uses the canonical planning revision lock, deterministic machine order and the canonical command receipt, actor and audit. The preview hash rejects changed plans. The exact Idempotency-Key/payload recovers uncertain publication. Reference availability is revalidated and snapshots are resolved after locking. Exclusion/deadlock/serialization conflicts yield an actionable 409.

Existing plan checklists, justified authorizations, actual completion receipts and holds remain the execution authority. Reserving a machine or naming an assignee does not grant an operator authorization or certify execution. Native mobile clients may consume the same authenticated API; this web delivery is not a React Native app.
