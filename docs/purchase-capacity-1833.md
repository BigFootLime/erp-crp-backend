# Purchase capacity and route attachments — #1833

The technical dossier owns at most two material purchase lines. A PostgreSQL trigger locks the dossier before counting, covering concurrent API and import writes without deleting legacy data. Special-process operations support two distinct issued articles and two purchase lines; identical suppliers remain valid and supplier/price data stays on each purchase.

`gamme_operation_finitions.slot` identifies the primary (1) and secondary (2) requirement. Existing rows default to slot 1. The legacy single-finish API explicitly reads, updates and detaches slot 1, preserving the secondary requirement. The purchase binding command chooses an available slot and records its canonical specification. The operation title joins both short finish designations in slot order. Operation summaries expose both requirements and their suppliers without multiplying operation/cost rows.

Deleting a purchase removes only its requirement association and refreshes the remaining title, within the transaction. Issued article identities remain unchanged. Copying a route copies both requirements and slots but clears old purchase-line pointers, allowing attachment in the new route without reusing the source route’s line.

The additive migration replaces one-finish unique keys with operation/slot and operation/article keys. Runtime rollback requires preserving and reconciling secondary requirements before restoring old uniqueness. Frozen OF snapshots are never rewritten. The earlier dossier and operation-scope guards remain enabled.

No empty purchase update may recalculate totals. Attachment commands remain method-permission controlled and audited, with financial changes submitted separately.
