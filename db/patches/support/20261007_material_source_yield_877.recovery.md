# Observed material yield — #877

Additive nullable integer columns on immutable debit sources; no historical update,
delete or backfill. Prerequisites: material debits/remnants and production flow #822.
Run the supplied preflight and verify with the canonical patch runner on Test,
then Production with a current verified backup. Production data remains authoritative.

Rollback the application artifacts to the previous frontend/backend release while
retaining the two columns, constraints and all proofs. Do not drop the columns or
the deferred guard after any observed yield has been written. The previous app
can still insert entirely unknown source yields; this compatibility does not
reconstruct a per-lot allocation. Corrections of known yields require the new app.

At commit, each material need has the declared global good/scrap totals, including
signed inverse corrections. A historical debit with all source yields null stays
unknown. The existing immutable trigger still prevents rewriting a saved source.
ACTUAL/POTENTIAL is carried into the correction rather than reset by a default.

The combined business recipe and the prepared domain cases run at the end of the
implementation, as requested by Keenan. No full acceptance is claimed by compilation.
