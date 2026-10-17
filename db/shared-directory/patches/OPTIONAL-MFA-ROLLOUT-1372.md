# Optional MFA assurance rollout — #1372

The explicit product decision of 16 October 2026 permits password login for
ordinary employees. SuperAdmins and business administrators must use MFA.
An existing enrolled factor is never bypassed by changing the global policy.

The authority represents password assurance with four SQL/JSON null values,
never an invented factor UUID, version or verification time. A site JWT has no
MFA claims in that case. Live source policy, membership, account status, factor
state and epochs are checked on every validation; enabling MFA or making the
account privileged rejects a previous password-only session.

## Order and guards

Use a freshly verified backup and the privileged migration operator, never grant
DDL or authority access to the site runtime role. Record each authority/site DB,
immutable patch SHA-256 and verification result in the deployment evidence.

1. Every existing site: apply the site `20261016_account_mfa_requirement_1372.sql`
   and `20261016_directory_password_assurance_1372.sql` through the site migration
   runner with their prerequisites and support verifications.
2. Existing authority: apply the account-request authority patch, then
   `20261016_directory_optional_mfa_1372.sql`; run both authority verifications.
   This changes the global setting only after retaining administrator flags and
   existing MFA factors. It does not delete credentials, identities or sessions.
3. Start the new authority first, then all participating site APIs. Publish the
   public frontend only after real owner MFA login, ordinary password login,
   business-admin MFA enrollment, denied unselected modules and the request
   approval/rejection/retry paths pass.

The authority has its own systemd service and physical runtime identity; upgrading
only the fixed Production/Test APIs does not upgrade it. Record and verify its
actual executable separately. Preserve its private working directory and secret
configuration when selecting the new immutable executable.

Managed Test instances also need the site migrations and matching site binary.
Inventory the active managed instances and configured template before activation;
do not modify archived/reset databases or assume all names beginning with
`cerp_test_` are active instances. Prepare a new blank canonical template from the
migrated common Test schema, using the new immutable release and a new template
version. Verify its MFA column, null-assurance projection, technical metadata and
absence of business/account data before atomically selecting the new host
configuration. Retain the previous template/configuration for recovery. Do not
rewrite a previous template's identity or grant site applications access to the
credential authority.

For a new empty authority, the template/source must first have the additive
account-MFA column. `installEmptyDirectory` then creates the schema with optional
global policy and a durable MFA requirement for the seed owner. Apply the two
authority patches after installation, before starting its HTTP service.

`validate-actor-v2` returns the effective MFA requirement. The previous operation
keeps its original response shape for older site binaries. Existing MFA session
response shapes are unchanged. A password-only response is emitted only for an
eligible ordinary account and requires a new site binary; do not expose new
approvals until all sites are updated.

## Recovery

Retain the additive columns and null-pair constraints when rolling binaries back.
An old authority rejects password-only sessions, so a rollback must coordinate
the policy and employee access; it is not a promise of uninterrupted ordinary
login. Preserve owner MFA and roll forward the verified binary when possible.
Never clear factors, set fake assurance or disable account checks as recovery.

The Directory server runs bounded request expiry/redaction at startup and every
minute. It never overlaps cleanup within one process, and its timer is unref'ed
and closable. Request receipts are held only as hashes and are invalidated upon
redaction; the durable audit events contain no name, email, password or receipt.
