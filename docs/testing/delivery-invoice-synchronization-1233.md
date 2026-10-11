# Shipment and invoice synchronization

The reservation-based shipment path posted stock and the BL but omitted the
order workflow transition. Invoice issue then rejected PRET_LIVRAISON -> FACTURE
with ILLEGAL_COMMAND_STATUS_TRANSITION. Base Test BL56 / invoice1 reproduced it.

Both shipment paths now synchronize all orders represented by delivery lines,
in ascending order ID, within the shipment transaction. Fulfillment quantities
are grouped by the actual order line, including BLs containing multiple orders.
Partial shipment does not complete an order.

Invoice issue first reconciles an evidenced complete shipment through the
existing guarded LIVRE transition, then the FACTURE transition. This repairs
historical missing delivery checkpoints without skipping planning, quality or
other earlier gates. History, role checks, locking and idempotence remain active.
No migration or direct business-data repair is required.

Regression cases cover missing delivery synchronization, replay without duplicate
history, partial invoice, illegal earlier status and grouped orders with different
shipment completion. Actual acceptance must resume the existing approved invoice
through the normal Base Test UI and verify its document and command checkpoints.
