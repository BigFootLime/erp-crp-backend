# ADR-0959 — Return an unused assembly intake

The #956 intake creates immutable stock command receipts and proven component
issues. A generic stock reversal must not restore physical stock while leaving
its OF reservation consumed. #959 supplies the coordinated owner command.

Production lists the last fifty intake receipts and prepares a complete return
from one immutable correlation identifier. No article, lot, quantity, source OF
or unit is supplied by the caller. The command requires an unchanged preview,
a reason and explicit confirmation that all components were physically returned.
The original parent receipt and every child stock receipt, movement line and
consumption proof must agree with the current frozen requirements. Consolidated
requirements retain their original source OF allocation.

This simple correction is deliberately limited to unused intake. Active quantity
declarations from assembly onward, downstream transfers, receipts/output lots,
quality controls/decisions/logs, successor work or loss complements forbid it.
Closed/changed operations, expired reservations, reversed issues or blocked lots
also forbid it. Their own correction circuits must reconcile actual downstream
use; this endpoint does not put used, scrapped or suspect components into stock.

Lock order is planning, OF, all source lots, then stock and reservations. Stock
creates exact canonical inverse movements preserving lot, location and price,
checks the paired compensation proof, and restores the original still-valid
reservation. Every component, the parent correction receipt and audit/outbox
commit together. A failed proof rolls back the entire return. Repeating the same
actor/key/body recovers the original result; another key cannot reverse twice.

Read APIs contain no prices. Submission requires production operation access
and stock compensation/reservation rights, respecting explicit account denials.
The legacy role fallback runs outside the ambient production-module grant.
No schema change or mutable replacement of stock receipts is required.

TypeScript, build/OpenAPI and real application-role PostgreSQL PREPARE/EXPLAIN
are checked before release. Business/security/concurrency recipes remain prepared
for the final combined acceptance, per the human instruction of 7 October 2026.
The first contract build caught an OpenAPI 3.0 exclusiveMinimum type mismatch;
the schema now uses minimum 0 and exclusiveMinimum true.

This is a backend correction foundation. The #956 assembly work remains open
for CERP/React Native confirmation UI, the agreed intake trigger, and the output
quantity gate. No automatic issue is inferred from starting time or rework.
