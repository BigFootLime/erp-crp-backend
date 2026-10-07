# Native cutting terminal 896 recovery

This patch extends the terminal kind constraint. It creates no PIN, terminal, material movement or production record.
Run preflight, preserve a complete recovery set and Test/Production dumps, then apply with the canonical patch runner. Verify the constraint and compile runtime SQL as cerp_app.

Rollback the application to its preserved release while retaining the additive CUTTING kind. Existing native terminal, session and material histories must remain. The rollback SQL is a rehearsal ending with ROLLBACK; it refuses removal if a CUTTING terminal exists.

Lost debit responses are recovered using the same payload and Idempotency-Key. Do not replace an uncertain confirmation with a new debit. Revoked native PIN/device/account sessions are revalidated inside the canonical material/execution transaction.
