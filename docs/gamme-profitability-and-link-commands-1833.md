# Route profitability and reversible purchase attachments — #1833

`PATCH /pieces-techniques/:id/achats/:achatId` accepts an isolated `gamme_operation_id` command: a UUID attaches or moves, `null` detaches. Both require the Methods operation-write permission. Transactions lock the dossier and both operations, require mutable routes in the same dossier, retain the purchase and its financial/cutting data, and move only that line’s canonical finish requirement. A destination capacity/specification failure rolls back the original link as well. The old operation title is rebuilt from its remaining finishes, or reset to Procédés Spéciaux when empty. Cutting-operation titles remain unchanged.

`prix_vente_horaire` is an optional operation-owned selling rate. It is independent of the existing operation cost-rate override and the part’s selling price. The nullable additive column preserves old rows and frozen OF snapshots; normal operation audit, optimistic lock and publication immutability still apply. Route revisions copy the value through the existing column-aware copy mechanism.

`GET /gammes/:gammeId/profitability?quantity=N` requires Methods operation-read and tariff-read capabilities. Its repeatable-read transaction calculates two independent margins:

- Operation revenue = its selling hourly rate × (setup hours + cycle hours × base quantity × coefficient × lot quantity). Operation cost uses its own cost rate on the same time basis.
- Part revenue = `pieces_techniques.prix_unitaire` × lot quantity. Cost = operation costs + purchase costs. Operation selling revenues are never added to part revenue.

Material blank counts reuse the canonical production document cutting calculation, including whole-blank rounding. Stored purchase prices remain authoritative; absent prices are not replaced by catalogue guesses. Setup is counted once per lot. Non-EUR operation costs are excluded from the known EUR subtotal and require conversion before a global margin is shown. Assembly child costs are marked incomplete rather than silently omitted.

Margin percentage = (revenue − cost) / revenue × 100. Display thresholds are explicit: strong ≥20%, good ≥10%, tight ≥0%, loss <0%. Unknown revenue/cost is neutral. A known zero selling rate can show a loss without an undefined percentage. Missing rates, machine cycle times, prices and conversion are returned as reasons. This is a dossier estimate, excluding overhead absent from the dossier, and does not rewrite an OF financial snapshot.

No test campaign was run, per the user’s direct-delivery instruction. TypeScript, lint, API contract and release-integrity checks are recorded in the private delivery receipt.
