# Personal profile — #1338 / CERP-SELF-ACCOUNT-01

`GET /api/v1/auth/me/profile` returns the authenticated user's contact and avatar
presentation. `PATCH` on the same path accepts only `name` (family name), `surname`
(given name), `email`, `tel_no` and the shipped `avatar_key` enum. At least one
field is required. The actor ID comes from authentication; payload target IDs,
username, roles, status, superadmin, employment and credential/MFA fields fail
strict validation. Existing authentication and active-account checks apply.

With the shared directory enabled, updates use the private HMAC operation
`profile-self-update`, whose target is the validated opaque session's source
actor. Fresh directory identity is projected back to the business database.
Telephone is now part of the common profile; the legacy-disabled-directory path
uses the same narrow repository. Presentation reads prefer canonical directory
username/email over retained local collision aliases. No credential or source
session reference is included in this profile DTO.

Names, email and French telephone are normalized; conflicting email returns 409
`PROFILE_EMAIL_IN_USE`. The transaction locks the actor, updates only whitelisted
columns and writes an audit/outbox entry containing changed field names, without
contact values. Repeated saves of identical values create no duplicate audit.
Password, MFA, authorization versions and memberships remain unchanged.

Selecting a preset clears the current `profile_picture` pointer. Previous media
records/files and audit history are retained, with their existing ownership and
read authorization. Uploads continue through the existing byte validation,
antivirus, opaque media and idempotency pipeline; no new storage path is exposed.

Verification on 2026-10-14: build/typecheck PASS; 23 new validator/controller
checks PASS; full Vitest 749 files / 8,185 tests passed (31 files / 254 tests
skipped by existing environment requirements). The real HTTP directory fixture
under `cerp_directory_app` and owned loopback PostgreSQL passed 49 checks,
including cross-base contact, preset replacement after upload, no-op audit,
email conflict, target/privilege rejection and unchanged security fingerprint.
Evidence: `docs/testing/evidence/shared-directory-sessions-1568.json`.
The image scanner in this fixture is simulated; no live account is edited.

No migration or dependency is required. Deploy the authority and all site APIs
together, before the UI: older strict directory clients do not understand the
new telephone profile field. Release, native Electron verification and live
confirmation belong to the coordinating delivery chat. State REVIEW pending
that integration; full business recipe is outside this fix.
