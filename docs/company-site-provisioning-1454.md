# Company site provisioning

For a new opaque `cerp_company_<uuid>_(prod|test)` database, provision the approved schema-qualified template first. Apply the dedicated `db/company-sites/20261026_company_directory_sites_1454.sql` foundation and only the additive patches required by that template, including the company policy projection patch. Run each matching preflight and verify script. The company-only foundation is intentionally outside the automatic business patch runner: its database-name guard would reject an ordinary CRP database.

Do not run the historical shared-directory-sites patch against a company database, modify patch checksums, forge a migration ledger, import users, or put directory secrets in the database. This patch creates projection metadata only; it neither creates databases nor grants a business membership.
