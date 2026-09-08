# Recovery — receipt conversion and command identity

Back up before applying; run preflight and verify under the existing application role. The patch adds nullable metadata only and does not infer conversions for historical receipt lines. Record the hash of the exact UTF-8 SQL applied.

For application rollback, retain the conversion columns, immutable conversion trigger and command identity index. Preserve stock movements, stock receipts and transfer links. Do not erase these ledgers to retry a receipt. Existing receipts with matching units remain usable; different legacy units need an explicitly reviewed correction, not a guessed supplier conversion.

Revert the test service to its backed-up release drop-in if readiness fails, without switching production. An old receipt handler cannot safely stand in for the new transactional handler after material transfers have been activated: keep receiving read-only until the corrected handler is restored. Stored reservations remain authoritative.
