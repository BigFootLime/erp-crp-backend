# Shared-directory account-request patches

`20261016_self_service_account_requests_1372.sql` is applied only to the
canonical `cerp_directory_<uuid>` authority database.  It must never be passed
to `scripts/db-patches.js`, which enumerates the site patch directory and would
therefore reject it on `cerp_prod` or a managed Test database.

Apply order for a new authority is: create and verify the canonical directory
database; have the verified privileged migrator apply
`20261016_account_mfa_requirement_1372.sql` to the authority source and every
participating site; run `installEmptyDirectory`; then have that migrator apply
this authority patch. `cerp_directory_app` is the runtime role: it has no DDL
authority and must never apply either patch. Run
`support/20261016_self_service_account_requests_1372.verify.sql` against the
authority after apply. Record the authority database id, each patch SHA-256,
and the successful authority/site verification in the deployment ledger before
starting directory or site routes. The account-request patch grants no
request-table access to `cerp_app`.

The authority patch creates the request/event tables and grants the directory
application role only the operations required by the signed directory service.
It does not create a site user, change a site membership, or activate a
request.  Approval leaves the Production membership inactive until the site has
projected the profile and closed all unselected local modules.

Pending requests expire after 30 days. The directory housekeeping task then
expunges submitted-form fields from terminal requests 30 days after their
decision (or expiry): name, surname, email, password hash, avatar choice,
username base, rejection reason, and receipt hash are removed or replaced.
Approved rows retain only the decision audit linkage (profile, allocated
username, mutation response, and append-only event references); this is
pseudonymised audit data, not complete anonymisation or a compliance claim.
