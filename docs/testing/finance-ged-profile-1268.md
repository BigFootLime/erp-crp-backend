# Finance GED profile compatibility

The production database deliberately retained its SOL-20 GED link guard after the historical compatibility bridge was removed. Test retains the closed entity metadata registry. The first Finance deployment exposed this supported profile difference: the proforma migration needs `ged_entity_types` even though the legacy database has no such relation. Its transaction rolled back; no production business data was replaced.

The additive profile patch installs the same canonical entity metadata in the legacy profile, retains its original guard and all documents/links, and adds an explicit existing-parent check for private proformas. It leaves the closed profile's registry and guard in place. This is a schema alignment using Test as the model, without copying users, clients, invoices or other business rows.

Migration dependencies place this patch before proforma funding. On an already upgraded Test database it is the only pending patch; on legacy Prod it precedes the six Finance patches. The final proforma verifier checks the exact six, eight or nine canonical fiscal/cash writers according to the installed refund models. It verifies every expected relation/function binding instead of assuming the original count remains six.

Qualification uses isolated PostgreSQL databases restored from each live schema only. Checks cover apply/reapply, application-role verification, protected empty legacy rollback, refusal to roll back an installed Finance model, unknown proforma parent rejection, and the final seven migration verifiers. These checks do not close the real business recipe. Fresh VPS-verified Test/Prod dumps and full HYPERBOX2 recovery snapshots precede live changes.
