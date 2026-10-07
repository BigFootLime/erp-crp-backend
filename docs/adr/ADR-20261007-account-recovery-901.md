# Superadministrator account recovery — #901 / WP-283

- Date: 2026-10-07
- Status: accepted for implementation; combined security acceptance pending
- Decision source: Keenan Martin's request to recover lost 2FA and reset the password

ADR-0078's out-of-band recovery remains mandatory for the last available
superadministrator and self-recovery. For another active account, the requested
in-product recovery is permitted only to a live superadministrator with recent
MFA. Module access or an administrator role label is insufficient.

The command requires a factual reason, explicit identity verification and an
idempotency key. It locks accounts in increasing ID order, checks the actor's
durable session epoch and exact active factor, and atomically invalidates the
password, factors, recovery codes, pending challenges, old reset links, PINs,
badges and station sessions. It preserves audit records, credentials and running
production pointages. Account locks precede station credential/session locks;
opening a station and authorizing a cutting write use the same order.

A 15-minute single-use link reuses the canonical password-reset endpoint. Only
the reset-token hash is stored. Idempotent retries reconstruct the same bounded
opaque token from the durable recovery row; a used, expired, superseded or
completed link is not disclosed again. The frontend keeps it in component memory,
outside caches and storage, and uses the HTTPS web entrypoint from Electron.
No email is sent automatically.

The mandatory reenrollment flag is independent of the global optional/disabled
MFA policy. Password login rechecks the locked account after bcrypt validation;
new-factor confirmation is the only action that clears the flag and completes
the recovery. A recovered user can then configure a new PIN or receive a newly
issued badge. Revoked credentials are never restored by the recovery.

The additive migration changes no existing credentials. Before first use,
rollback is guarded by empty recovery evidence and no forced reenrollment while
writers are stopped. After use, old code would ignore the mandatory flag: retain
the schema and deploy a compatible forward fix. Never clear the flag or revive
old credentials as an operational shortcut.

`security.account_recovery_enabled` starts false. Deployment activates it in
each database only after exact compatible versions are ready on every API
instance, including the public API's Test/Production routing. This closes the
recovery command during a rolling rollout; an older instance must never serve
login while new recovery commands can create forced reenrollment.

Verification is limited to compilation, lint, SQL/schema checks and deployment
health until the user-requested combined recipe. Security scenarios are prepared
in frontend `docs/testing/account-recovery-1180.md`; deployment does not reset a
real account or prove successful end-to-end recovery.
