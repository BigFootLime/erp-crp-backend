# Stock-only replay after an explicit prelaunch cancellation

Issues backend1305/web1553, WP285. The command launcher remains the authority: an explicit POST verifies exact active reservations and all active OF, then prepares AR without creating another OF/BL or changing reserved quantities. Read requests never perform this repair.

Before cancellation, Test command109 has12 ordered/reserved,0 to produce, OF92 BROUILLON with0 output and no actual start. A readonly execution of the real guard refuses repair even with an empty passed generated-OF list. The actual cancellation preview proves no pointage/debit, stock reservation, planning, grouping or child OF; one purchase assignment has1326 units. The raw-material purchase is received and preserved.

Cancellation is an ordinary authorized, optimistic OF transition. Under planning/OF locks, active commitments fail closed; inactive purchase assignments are marked cancelled in the same audited transaction. Their quantities, receipt offsets and IDs remain recorded. Purchase audit/outbox invalidation is published transactionally. All purchase terms, receipts, stock levels/batches, prices and physical quantity remain untouched. Started OF and their material dispositions remain outside this prelaunch path.

The frontend counts active artifacts, preserving cancelled history. Its existing launcher dialog performs the replay. The delivery table shows a command shortcut for reserved stock with prepared_qty=0; only a positive prepared quantity advertises an existing BL.

Record live cancellation, guard-after result, AR/BL/invoice and material-assignment evidence separately. This document is not proof that the complete recipe has passed.
