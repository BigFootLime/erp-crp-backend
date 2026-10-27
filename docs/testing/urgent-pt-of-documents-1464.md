# PT / OF imported inspection — #1464

Frontend #1786. Human request, 2026-10-27: recognize the existing approved XLSX inspection sheet on the shared Test part instead of asking for another upload; expose separate upload slots and operator improvement feedback.

Preparation evidence now includes exact clean, released and applicable GED versions. A revision-scoped FICHE_AUTOCONTROLE source is recognized. The historical RELEVE_CONTROLE / DOSSIER_TECHNIQUE attachment is recognized only when explicitly named as an inspection sheet and the part has one unambiguous external index. Ambiguous multiple templates are not silently selected. File hashes are retained in technical evidence. Revoked, quarantined or unrelated files cannot serve as execution evidence. Existing frozen legacy rules retain their generated-sheet requirement.

The uploaded Excel sheet is distinct from a structured digital control plan. A FICHE_AMELIORATION operator return creates a visible, nonblocking index-review item; ordinary purchases and uploads do not increment the customer index.

Validation: targeted domain unit tests; TypeScript compilation; exact document CTE executed against cerp_test within BEGIN READ ONLY / COMMIT, finding the existing client plan and MD07 XLSX without database mutations. No migration. Release base 870c7ed0; EC main is excluded from this hotfix. The existing workshop PDF packet still expects a generated inspection PDF; the original XLSX remains directly downloadable and is not falsely described as a rendered PDF annex.
