# Supplier suggestion context regression (#1070)

WP-285 business recipe showed unavailable suggestions although the Test API
returned HTTP 200. `ordres_fabrication.id` is bigint; node-postgres returns it as
a string. The browser validates a numeric `context.of_id` and rejected it.

Use the already validated numeric route identity in the public evidence context.
The query remains scoped by that identity. No global PostgreSQL type parser,
schema change, permission change, pricing change, or purchasing mutation is made.
The fingerprint uses the same corrected context that is returned to the caller.

Regression coverage executes the repository with a bigint string result, empty
supplier history, both price access modes, and missing OF rollback. Before the
fix, both success cases reproduce the wrong wire type. Existing evidence and
ranking tests remain required. Recheck the actual Test browser after deployment;
unit success alone does not complete WP-285.
