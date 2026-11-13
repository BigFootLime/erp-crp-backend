# PT / OF imported inspection — #1464

Frontend #1786. Human request, 2026-10-27: recognize the existing approved XLSX inspection sheet on the shared Test part instead of asking for another upload; expose separate upload slots and operator improvement feedback.

Internal MINOR revisions also preserve the existing clean, released and applicable drawing/inspection links when the client index and drawing reference are unchanged. A changed drawing or MAJOR revision never inherits these links automatically. The existing clone transaction audits the copied link count; files are not duplicated.

Startup compatibility #1468: legacy metrology digest references are resolved directly in the canonical metrology vault, preserving allowed roots, audit and SHA validation on both download routes. Future CLI imports emit the canonical prefix. The storage preflight remains unchanged; the operator handles the backed-up legacy alias after byte verification. Integrated from the independently reviewed author snapshot (8 source/test files); 108 targeted Vitest tests and 4 CLI tests pass, with one filesystem-symlink fixture skipped because Windows denies symlink creation.

Preparation evidence now includes exact clean, released and applicable GED versions. A revision-scoped FICHE_AUTOCONTROLE source is recognized. The historical RELEVE_CONTROLE / DOSSIER_TECHNIQUE attachment is recognized only when explicitly named as an inspection sheet and the part has one unambiguous external index. Ambiguous multiple templates are not silently selected. File hashes are retained in technical evidence. Revoked, quarantined or unrelated files cannot serve as execution evidence. Existing frozen legacy rules retain their generated-sheet requirement.

The uploaded Excel sheet is distinct from a structured digital control plan. A FICHE_AMELIORATION operator return creates a visible, nonblocking index-review item; ordinary purchases and uploads do not increment the customer index.

Validation: targeted domain unit tests; TypeScript compilation; exact document CTE executed against cerp_test within BEGIN READ ONLY / COMMIT, finding the existing client plan and MD07 XLSX without database mutations. No migration. Release base 870c7ed0; EC main is excluded from this hotfix. The existing workshop PDF packet still expects a generated inspection PDF; the original XLSX remains directly downloadable and is not falsely described as a rendered PDF annex.
