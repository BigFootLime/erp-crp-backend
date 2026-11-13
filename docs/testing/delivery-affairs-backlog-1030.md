# Common acceptance: delivery affairs

Prepared, NOT RUN: user requested one combined métier/UI recipe after the full flow.

- Create an article allocation without reservations: visible with client name/code, customer PO, affair, requested quantity and zero reserved/shipped.
- Add an active reservation: held quantity changes; exact lot appears when preparing that affair. Unrelated reservations are excluded even when the global cart has more than 200 rows.
- Prepare part of the quantity: show preparation separately. A DRAFT/READY BL does not make the delivery partial or complete.
- Ship part: orange partial state and explicit text; remaining equals requested minus actual shipped/delivered allocations.
- Ship the rest: green complete state. Cancelled BLs do not inflate the counters.
- Change the delivery date/split an urgent part: the initial sent AR remains unchanged; modified dates retain their existing affair history and OTD evidence.
- Without sent AR evidence: display AR non tracé. Never substitute the current requested date.
- Select affairs with different clients, destinations or canonical contracts: selection guidance blocks mixing and server checks remain authoritative if data changes after selection.
- Missing preparation/quality/physical availability remains a blocker; reading the list does not create usable stock.
- Search, state filters and pagination retain the same ordered technical version. Page/filter changes clear selection.
- Repeat on Test with OLD stock and its documentary provenance; do not reinterpret it as a newly manufactured lot.

Increment checks: TypeScript, targeted frontend lint, immutable builds/OpenAPI and read-only PostgreSQL PREPARE. Business data mutation and UI captures remain for the common recipe.
