# U11 — Delivery printing repository boundary (#1522)

`livraisons.repository.ts` remains the compatibility facade for delivery callers.  The
printing read model and the print-retry transaction now belong to
`delivery-printing.repository.ts`.

`delivery-events.repository.ts` est le propriétaire inférieur unique de
`insertEvent`. La façade et le propriétaire d'impression l'importent directement;
ainsi l'événement SQL, son invalidation temps réel et sa déduplication ne sont pas
copiés et aucun propriétaire n'importe la façade.

The new owner opens and releases its own PostgreSQL client exactly as before.  The
retry keeps the existing order: lock the BL, lock or insert the print outbox row,
write the delivery event and its realtime invalidation, write the audit record,
then commit.  It imports shared infrastructure directly and never imports the
legacy facade, so the extraction cannot form a facade cycle.

Acceptance criteria:

- public exports and signatures from `livraisons.repository.ts` stay stable;
- SQL, parameters, transaction boundaries, event/audit ordering and error paths
  remain unchanged;
- a mock-pg regression invokes the public facade and records the retry sequence;
- source checks compare the moved public declarations and the compiled graph
  confirms that the printing owner has no dependency on the facade.

This source-only change does not change routes, authorization, business rules,
database schema, external printing, or deployment.
