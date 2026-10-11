# Canonical client identity in central planning

Issue #1206 / WP-287. The existing read-only task query joins `clients.client_id` to the owning manufacturing order, using the same canonical company name and `color_hex` / `color` compatibility adapter as the legacy planning repository. The v2 snapshot adds optional `clientName` and `clientColor` alongside `clientId`.

No extra request per task, migration, permission expansion, schedule calculation or stock write is introduced. Missing client metadata returns null. The existing task version covers these fields so an identity update invalidates stale client presentation. Frontend rendering accepts only normalized hex colors and uses neutral surfaces when no color exists.

Validation covers identity, absent metadata, version invalidation, routing identity and full TypeScript compilation. UI verification belongs to frontend #1445; industrial end-to-end recipe remains separate.
