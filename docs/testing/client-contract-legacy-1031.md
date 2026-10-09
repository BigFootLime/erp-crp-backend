# Combined acceptance: historical CADRE association

Prepared, NOT RUN. Execute with the complete #1028–#1035 métier/UI recipe requested by Keenan.

- Review a same-client CADRE with a partly delivered historical release and an older ordered index. Associate with the matching active contract. Keep order, releases, BLs, OFs, sent AR and OLD-stock documents byte-for-byte unchanged; only the association, audit and outbox are new.
- Inspect the saved source after a later permitted quantity/date edit. Original source values remain visible, current canonical quantities remain governed by existing order policies, and OTD is not rebased.
- Missing historical technical version stays unknown. Association must not grant OLD-stock exception, usable stock, quality release or manufacturing readiness.
- Identical reference/designation with another article family cannot match. Refuse missing article, ambiguous family, invalid ordered PT/version and a different/ambiguous canonical unit. Do not map unknown data to the current index.
- Refuse another client, inactive/blocked/archived client, inactive/stale contract, already associated order or existing firm-call binding. No partial ledger, audit or outbox survives.
- Change source header/line/release or contract after preview; confirmation rejects stale evidence. Repeat while source edits/new release lines run concurrently; either the source commits first and stale confirmation fails, or association commits first and composition is refused.
- Send concurrent identical actor/key/body, retry after lost acknowledgement, switch database/account and close/reopen the dialog or contract tab. Exactly one association; uncertain retry retains captured database, exact body/key and preview. Conflicting body/key is rejected. Simulate COMMIT acknowledgement reconciliation without inventing success.
- A pending BL with a now-incompatible source blocks association and preserves the former historical scope. A compatible same-contract new-call/associated-CADRE BL is allowed. Another/no contract and unbound manual lines remain refused. Actual shipment rechecks scope and quality; old shipment previews become stale.
- Directly forge canonical order/client/type, remove/add/move historical lines, change article/PT/version/unit, delete or duplicate associated CADRE, and add/edit release composition. Service and database guards retain identity. Existing release status/date maintenance remains available.
- In the UI, inspect historical lines/indices, recorded association reference/version/reason and historical releases. Identity controls and deletion/new-CADRE-call actions do not offer known-invalid changes. New demand starts from the client contract. Cover empty/loading/error/retry, keyboard, light/dark and narrow viewport.

This increment does not certify proforma payment guards, forecast conversion or urgency/recovery. Those scenarios remain part of the final common recipe.
