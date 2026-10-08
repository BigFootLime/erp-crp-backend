# ADR-0944 — Quantité déclarée en sortie d’OF

Status: implemented; final combined business acceptance pending.

`good_quantity` previously summed good pieces at every operation. A piece could therefore be counted after cutting and again after machining. The margin engine now reports good pieces declared at the terminal, non-cancelled operation of the active routing. Intermediate declarations remain work in progress. This follows the material execution circuit’s existing terminal operation rule.

Expose the selected operation, declaration count and freshness, and pending control quantity. No declaration at the terminal operation leaves the output unknown (`null`); an explicit zero remains zero. Signed compensations contribute to the same terminal ledger. Superseded routing declarations do not become output of today’s routing. Historical real time and declared scrap stay attached to their original execution. Rework is declared operation activity, not a count of distinct physical pieces.

This quantity is declared output, not quality release, accepted stock or dispatched quantity. The change does not rewrite declaration history, historical OF counters or stock. Existing final-operation selection assumes the current sequential routing; parallel routing would need explicit output milestones before using this definition.

No migration or client-facing PDF change. Internal measurement fields are additive. TypeScript/build and SQL compilation are performed before deployment. Temporary-fixture business cases are prepared but execution remains deferred to final combined acceptance by explicit user instruction. WP-278, issue #944; sections 7/9/12/14/15/16.
