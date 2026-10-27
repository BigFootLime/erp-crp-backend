# Intercompany commercial catalogue contract (#1454)

This contract is scoped to a company runtime whose profile is `COMMERCIAL`.
It never grants stock, lot, production or procurement-worker capability.

## Endpoints

- `GET /api/v1/fournisseurs/intercompany/catalogue`
  returns active EC catalogue mappings visible to the caller's company context.
- `POST /api/v1/fournisseurs/intercompany/catalogue`
  creates an explicit EC sale mapping. Required body:
  `{ supplier_id, supplier_catalogue_id, designation, unit, ec_sale_unit_price,
     crp_article_id, crp_piece_technique_id?, crp_piece_technique_version_id?,
     crp_supplier_reference?, purchase_unit_price, currency }`.
  `supplier_id` is the configured CRP supplier relation. Prices are server-captured;
  no price is inferred from an article sheet.
- `PATCH /api/v1/fournisseurs/intercompany/catalogue/:id`
  requires `{ expected_version, ...mutable mapping fields }` and returns the next version.

## Confirmed EC order

The existing customer-order confirmation adds the persisted value
`fulfilment_mode: "SUPPLIER_DROPSHIP"`. Such an order has no EC quote, stock,
lot or work-order path. Its confirmation atomically creates a supplier PO in EC
using the existing supplier-order tables, one row per mapped line, and later
the outbox owner emits `PURCHASE_SUBMITTED`.

The message payload is versioned and contains only explicit bindings:
`{ schema_version: 1, buyer_sales_order_id, buyer_purchase_order_id, relation_id,
  buyer_company_id, supplier_company_id, delivery_address, lines: [{
  catalogue_mapping_id, supplier_catalogue_mapping_id, mapping_version, supplier_article_id,
  supplier_piece_technique_id?, supplier_piece_technique_version_id?, quantity, unit,
  purchase_unit_price, purchase_vat_rate, currency, supplier_reference?
}] }`.

The buyer sale price is private and must not be forwarded to the supplier. The supplier's
adapter receives the purchase price and validates every article/PT/version
binding before creating its native customer order. Missing or stale bindings are
blocking errors; there is no article, price, VAT or unit fallback.

The durable correspondence is generic: `intercompany_purchase_order_links`
(`buyer_sales_order_id`, `buyer_purchase_order_id`, `relation_id`) and
`intercompany_purchase_order_line_links` (`buyer_sales_order_line_id`,
`buyer_purchase_order_line_id`, `catalogue_mapping_id`, `mapping_version`).
The shared relation UUID is explicitly configured on both sides. A supplier can
otherwise resolve its relation only by `(source_company_id, destination_company_id,
environment)`, never with a buyer-local line ID.
