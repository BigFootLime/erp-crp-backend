This additive patch does not rewrite an existing allocation or purchase. Back up
the named database before preflight, apply and verify, then record the SHA-256.
Keep both additions when reverting application code: dropping receipt offsets
would silently reassign already received material. Restore a backup only through
the established recovery procedure after reconciling subsequent business writes.
