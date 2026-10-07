# Account recovery — #901 / WP-283

Additive migration; no account, factor, password or session is modified by the patch.
Apply preflight, backup and migration before the new backend, then verify under the
canonical database owner. Test and Production are separate targets.

The application action, exclusively for an active superadmin with recent MFA,
atomically revokes the target's password, existing factors, recovery codes, challenges
and durable ERP sessions. A 15-minute single-use link reuses the public password reset
endpoint; next password login requires QR enrollment even with optional/disabled MFA.
Evidence contains hashes and a factual reason, never the token or TOTP secret.
`reset_id` intentionally has no cascading FK: normal reset-token cleanup must retain
recovery evidence. Only successful new-factor confirmation clears the forced flag.

Runtime rollback to code predating #901 is allowed only if the table is empty and no
forced enrollment exists, while writers are stopped. The SQL rollback refuses any
evidence or forced flag. Once recovery has been used, retain schema and deploy a
compatible forward fix. Never clear the flag, delete evidence or restore an old
password/factor to bypass enrollment. No account reset or email is performed by a
deployment/verification script.

Security/business suites are prepared for the final combined acceptance, deferred
at the user's request. Builds and SQL compilation are not account recovery acceptance.
