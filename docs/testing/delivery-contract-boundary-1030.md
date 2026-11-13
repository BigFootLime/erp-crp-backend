# Common acceptance preparation — #1030 contract boundary

Status: PREPARED, NOT RUN. Business/UI acceptance runs with all lots, per user instruction. TypeScript, lint/build, generated API coverage, SQL preparation and release health are technical release gates.

Exercise ordinary same-client/destination orders, two firm calls of the same contract, calls of different contracts, contract versus ordinary order, identical display references but distinct contract IDs, and two historical CADRE orders. Only the first two compatible groups may combine. Contract closure/new master version must not alter recorded calls or block their compatible fulfillment.

Exercise direct BL creation, create-from-order, reservation cart, header/line edit, allocation addition, DRAFT→READY, canonical shipment and reservation-cart shipment. Reject a different client/contract source and a manual unbound line in a contract BL before transaction commit, event, archive or stock movement. Existing malformed drafts must appear blocked in the preview and remain editable toward a valid composition; cancellation and removals stay available.

Check the optional cart flag against an older strict client, guided selection including initial multi-selection, refresh, missing scope and alternate database/auth session. Backend submission of a forged selection must still fail. Confirm same-key replay returns the original result and does not duplicate shipment. Capture viewport/theme and console during final UI acceptance.

Still required in later increments: all affairs including those without sufficient reservations, complete/partial quantity styling, explicit proforma linkage and payment withdrawal before shipment, full stock lane/urgent recovery scenarios. This document does not certify those pending capabilities.
