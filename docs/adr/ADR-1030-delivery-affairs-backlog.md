# Delivery affair backlog and BL preparation

Status: implemented; combined business/UI acceptance pending.

The delivery worklist starts from `commande_ligne_affaire_allocation`, not from stock reservations. Each article-bearing customer delivery allocation remains visible before stock is reserved. Internal orders and cancelled affairs are excluded. The query reads the page, total and counters in one PostgreSQL statement.

The customer name/code, external PO reference (`commande_client.code_client`), internal order, affair and ordered technical version remain separate identities. The original AR deadline comes exclusively from `delivery_promise_roots.initial_due_date`; absent evidence stays null. A requested commercial date does not become sent-AR evidence and does not replace the OTD baseline.

Requested quantities belong to the allocation. Active reservations report held and still preparable quantities separately. Draft/ready BL allocations report preparation. Only shipped/delivered BL allocations count as delivered; cancelled BLs are excluded. Historical `qty_delivered` counters are not substituted for actual shipment evidence.

`GET /livraisons/affaires` uses the existing authenticated delivery read capability and strict bounded filters. It writes no stock or reservations. The optional bounded `reservation_ids` cart filter selects the exact reservations behind the chosen affair lines. Physical/quality/traceability and canonical client/contract checks still execute in the existing cart and every backend BL write. Client code is added only to the opt-in cart metadata, preserving older strict response shapes.

No migration, stock transfer, guessed article index, automatic contract reprise or automatic proforma payment validation is introduced. These are separate increments of #1030–#1035.
