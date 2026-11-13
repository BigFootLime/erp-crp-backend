# Sourced material invoice reconciliation — #1019

An approved material invoice must not overwrite old purchase prices, physical
Stock, or immutable OF margin snapshots. The original booked receipt value is
read from the protected CUMP receipt entry. Invoice approval, complete fiscal
archives and any explicitly approved header allocation supply the new HT value.

`GET /supplier-invoices/:id/material-reconciliation` is a private Finance read
requiring `supplier_invoice_read`. It accepts an invoice UUID, never an amount.
Six reads share one repeatable-read, read-only transaction and a nine-second
deadline. Existing lot/movement indexes locate immutable postings. Proof arrays
are bounded, with explicit incomplete-source outcomes rather than partial sums.

The initial policy requires one uniquely attributable lot per receipt, full
receipt quantities covered by the invoice line, company ownership and EUR.
Units are compared through the Stock vocabulary; only captured conversion
coefficients link purchase quantities to actual Stock quantities. A lot shared
between lines, another approved invoice covering a receipt, positive opening,
unrelated incoming posting, return/reversal, missing capture or unreconciled
physical remainder produces explained UNKNOWN. Three complete, identical
internal transfer postings are neutral. Batches are counted without adding
their parent levels. Depreciation reduces usable remaining quantity.

Within each invoice line, its documented HT is allocated cumulatively by
purchase quantity in lot UUID order, preserving the residual at twelve decimal
places. Each lot's variance is its invoice allocation minus original receipt
entries. Stock variance is that signed variance times remaining/received Stock
quantity; consumed variance is the exact remainder. Units/articles are never
added as quantities. Original receipt reliability remains visible: approved
invoice evidence does not convert a DECLARED historical basis into VERIFIED.

`calculable` describes arithmetic evidence; `projection_ready` separately
requires the current protected Stock candidate and known balance. Exhausted
stock can have a calculable consumed variance but is not yet declared ready by
the current positive-stock candidate. CUMP stays PREPARED for combined
acceptance. `posting_available=false`, `applied=false` and
`requires_financial_confirmation=true` are unconditional in this release.

The complete observed source is hashed. A subsequent additive financial
posting task must re-read it under the existing projector lock and journal
commit barrier, serialize invoice/intent, append an idempotent correction and
audit, attribute consumed variance, and support exhausted stock. Partial
invoices, credits and mixed-lot attribution need explicit owner policies;
this endpoint reports them rather than silently supplying approximations.

No schema change, new dependency, historical backfill, remote AI request,
automatic invoice approval or actual financial correction is introduced.
