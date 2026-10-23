# Stock entry and warehouse mapping (#1428, #1429)

In shared Test, the three configured locations belonged to the expected warehouse,
but their magasin had a NULL warehouse_id. The STOCK prerequisite gate correctly
rejected the movement. This was independent of technical-piece completeness.
The five current STOCK checks pass after a backed-up, conditional mapping repair.
No movement was created by this intervention; the failed attempts left zero stock
movements in shared Test at diagnosis time.

Creating an emplacement now retains an existing magasin warehouse mapping or
fills the missing link in the same transaction as location creation. The additive
patch reconciles existing exact-code matches without changing conflicting links.
Production has no configured physical locations at diagnosis time: code corrections
apply there, while creation of physical locations remains an explicit setup action.

Generic Stock > Movements > New movement exposed IN. The form now directs users
to the dedicated OLD recovery or supplier/production receipt workflows. The API
rejects generic IN preview, creation and posting, including pre-existing generic
drafts. Trusted internal source workflows and controlled compensations remain
available. Transfers, outgoing stock, inventory adjustments and scrap are preserved.
This is not a ban on authorized inventory corrections.

Verification: strict TypeScript compilation; 22 targeted route/policy checks.
The existing missing-lot test now uses an outgoing movement so it continues to
check lot enforcement independently of the new entry-source restriction.
The compiled baseline stock repository matches the actual VPS and native runtime
byte-for-byte before preparing the two-file runtime overlay. No dependencies or
auth settings change. Keenan explicitly requested publication and corresponding
Production fixes without a new full regression campaign.
