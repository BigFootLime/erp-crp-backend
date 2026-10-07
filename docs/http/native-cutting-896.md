# Native cutting and workshop client logos (#896)

CERP Découpe is a React Native application paired as CUTTING, without a terminal machine. Its worklist contains canonical material operations; OF scan and dossier use the existing station cutting services. It does not require an ERP browser cookie or generic API access.

The /terminals/cutting namespace exposes worklist, resolve-of, operation dossier, reserved-bar scan, debits, execution, immutable dossier documents and scoped client logo. Material debits and execution reuse the canonical station services. Before mutation, the transaction rechecks the device, native session, PIN, account epoch, role, expiry and cutting target. The existing full-material and lot-count checks remain authoritative. A terminal never books stock during a scan.

Both operator and cutting logo endpoints accept an OF/operation scope, never an arbitrary client/media id. Only the OF client's verified active CLEAN image with one matching client-owner binding is served; the delivery checks SHA and bytes. A missing or legacy unverified logo returns null. General client-media permissions remain unchanged.

The migration only adds CUTTING to cerp_terminals_kind_check. Enrollment/admin settings keep its machine null. See support preflight/verify/rollback/recovery files.

## Deferred combined recipe

Pair a CUTTING terminal and identify a production user. Select/scan a prepared material OF without a machine picker; view its released plan and full client logo. Verify unauthorized machine-bound and nonmaterial operations are rejected. Confirm full-material, critical one-lot and general two-lot limits. Scan an already reserved bar; record mm/units and actual/potential blanks; close a bar with measured remainder, explicitly confirm >150 mm. Retry a lost debit response with the same confirmation, prove one movement and one quantity receipt. Stop time, then preview/finish without declaring the same quantities again. Revoke PIN/device/account and verify no further stock mutation. Lock/change user and verify document cache cleanup. UI/device/business acceptance is deferred until all lots are implemented.
