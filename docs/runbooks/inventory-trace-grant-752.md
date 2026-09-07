# Inventory count privilege repair #752

A manual count failed with SQLSTATE 42501 on `DELETE FROM stock_lot_trace_references`. The count transaction rolled back. The runtime role lacked the live-reference correction privilege already specified in the August 31 inventory patch.

Apply `20260907_inventory_trace_grant_752.sql` after saving the preflight output for the exact target database. Run the support verification first on `cerp_test`, then on the separately authorized deployment target. It checks read/insert/delete rights on the mutable reference projection and the immutable lot-event trigger. Its `EXPLAIN` does not execute a delete.

No user role, route capability, event-log privilege, business row or counter is changed. Reference corrections remain inside the existing versioned inventory transaction, with before/after audit events. Counting does not post the stock adjustment; approval and closure remain separate actions.

Recovery: only if the saved preflight shows `can_replace = false`, restore the previous state with `REVOKE DELETE ON TABLE public.stock_lot_trace_references FROM cerp_app` in the same verified database. Do not revoke a privilege that existed before this repair. The defective count path would then fail again; preserve the saved count inputs for retry. No business-data rollback is needed.

Manual acceptance: save a fictitious discrepancy, verify the draft adjustment and unchanged physical stock, approve and close, then verify one posted adjustment and the resulting quantity. Keep all fixture creation and business actions in the UI.
