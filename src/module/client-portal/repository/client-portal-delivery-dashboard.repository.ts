import pool from "../../../config/database";
import type { ClientPortalIdentity } from "../types/client-portal.types";

type DeliveryEvidence = {
  bl_id: string;
  bl_allocation_id: string;
  bl_line_id: string;
  shipment_quantity: string;
  initial_due_date: string;
  due_date_at_shipment: string;
  departure_due_date_at_shipment: string | null;
  date_expedition: string;
  receipt_quantity: string;
  receipt_completed_at: string | null;
  receipt_mapping_is_unambiguous: boolean;
};
const n = (value: unknown) => Number(value ?? 0);
const onTime = (actual: string | null, promised: string | null) =>
  Boolean(actual && promised && actual.slice(0, 10) <= promised);

/** AR dates are customer-arrival promises, never invented dispatch deadlines. */
export function projectPortalDeliveryServiceKpis(
  evidence: readonly DeliveryEvidence[],
) {
  const shipped = evidence.reduce(
    (sum, row) => sum + n(row.shipment_quantity),
    0,
  );
  const proven = evidence.filter(
    (row) => row.receipt_mapping_is_unambiguous && row.receipt_completed_at,
  );
  const arrivalMetric = (promise: (row: DeliveryEvidence) => string | null) => {
    const promised = evidence.filter((row) => Boolean(promise(row)));
    const eligible = proven.filter((row) => Boolean(promise(row)));
    const eligibleQuantity = eligible.reduce(
      (sum, row) =>
        sum + Math.min(n(row.shipment_quantity), n(row.receipt_quantity)),
      0,
    );
    const onTimeQuantity = eligible.reduce(
      (sum, row) =>
        sum +
        (onTime(row.receipt_completed_at, promise(row))
          ? Math.min(n(row.shipment_quantity), n(row.receipt_quantity))
          : 0),
      0,
    );
    const promisedQuantity = promised.reduce(
      (sum, row) => sum + n(row.shipment_quantity),
      0,
    );
    return {
      promised_quantity: promisedQuantity,
      receipt_evidence_quantity: eligibleQuantity,
      on_time_quantity: onTimeQuantity,
      promise_coverage: shipped ? promisedQuantity / shipped : null,
      receipt_evidence_coverage: shipped ? eligibleQuantity / shipped : null,
      rate: eligibleQuantity ? onTimeQuantity / eligibleQuantity : null,
    };
  };
  const dispatchMetric = (
    promise: (row: DeliveryEvidence) => string | null,
  ) => {
    const eligible = evidence.filter(
      (row) => Boolean(promise(row)) && Boolean(row.date_expedition),
    );
    const eligibleQuantity = eligible.reduce(
      (sum, row) => sum + n(row.shipment_quantity),
      0,
    );
    const onTimeQuantity = eligible.reduce(
      (sum, row) =>
        sum +
        (onTime(row.date_expedition, promise(row))
          ? n(row.shipment_quantity)
          : 0),
      0,
    );
    const promisedQuantity = evidence
      .filter((row) => Boolean(promise(row)))
      .reduce((sum, row) => sum + n(row.shipment_quantity), 0);
    return {
      promised_quantity: promisedQuantity,
      dispatch_evidence_quantity: eligibleQuantity,
      on_time_quantity: onTimeQuantity,
      promise_coverage: shipped ? promisedQuantity / shipped : null,
      dispatch_evidence_coverage: shipped ? eligibleQuantity / shipped : null,
      rate: eligibleQuantity ? onTimeQuantity / eligibleQuantity : null,
    };
  };
  const confirmedQuantity = proven.reduce(
    (sum, row) =>
      sum + Math.min(n(row.shipment_quantity), n(row.receipt_quantity)),
    0,
  );
  return {
    dispatch: {
      initial: dispatchMetric((row) => row.departure_due_date_at_shipment),
      current: dispatchMetric((row) => row.departure_due_date_at_shipment),
    },
    arrival: {
      initial: arrivalMetric((row) => row.initial_due_date),
      last_agreed_at_shipment: arrivalMetric((row) => row.due_date_at_shipment),
    },
    receipt_evidence: {
      shipped_quantity: shipped,
      confirmed_quantity: confirmedQuantity,
      missing_quantity: Math.max(0, shipped - confirmedQuantity),
      ambiguous_allocation_quantity: evidence
        .filter((row) => !row.receipt_mapping_is_unambiguous)
        .reduce((sum, row) => sum + n(row.shipment_quantity), 0),
    },
  };
}

/** Every BL, receipt and promise evidence query is constrained by the account's delivery-site bindings. */
export async function repoPortalDeliveryDashboard(
  identity: ClientPortalIdentity,
  from: string,
  to: string,
) {
  const deliveries = await pool.query(
    `
    SELECT bl.id::text id,bl.numero,bl.statut,bl.date_expedition::text date_expedition,
      (SELECT count(*)::int FROM client_portal_delivery_receipts r WHERE r.bon_livraison_id=bl.id) arrival_proof_count,
      COALESCE(json_agg(json_build_object('id',line.id::text,'designation',line.designation,'article_code',line.code_piece,'quantity_shipped',line.quantite,'quantity_received',COALESCE(received.quantity,0),'quantity_remaining',GREATEST(line.quantite-COALESCE(received.quantity,0),0),'unit',line.unite) ORDER BY line.ordre) FILTER(WHERE line.id IS NOT NULL),'[]') lines
    FROM bon_livraison bl LEFT JOIN bon_livraison_ligne line ON line.bon_livraison_id=bl.id
    LEFT JOIN LATERAL(SELECT sum(x.quantity_received) quantity FROM client_portal_delivery_receipt_lines x JOIN client_portal_delivery_receipts r ON r.id=x.receipt_id WHERE r.bon_livraison_id=bl.id AND x.bon_livraison_ligne_id=line.id) received ON true
    WHERE bl.client_id=$1 AND EXISTS(SELECT 1 FROM client_portal_delivery_site_bindings b WHERE b.account_id=$2::uuid AND b.delivery_address_id=bl.adresse_livraison_id)
      AND bl.statut IN('SHIPPED','DELIVERED') AND bl.date_expedition BETWEEN $3::date AND $4::date
    GROUP BY bl.id ORDER BY bl.date_expedition DESC,bl.id DESC LIMIT 500`,
    [identity.clientId, identity.accountId, from, to],
  );
  const evidence = await pool.query<DeliveryEvidence>(
    `
    WITH scoped AS (
      SELECT bl.id bl_id,bl.date_expedition,bla.id bl_allocation_id,line.id bl_line_id,s.quantity shipment_quantity,r.initial_due_date,s.due_date_at_shipment,s.departure_due_date_at_shipment,count(*) OVER(PARTITION BY line.id) allocation_count
      FROM delivery_promise_shipments s JOIN delivery_promise_parts p ON p.id=s.part_id JOIN delivery_promise_roots r ON r.id=p.root_id
      JOIN bon_livraison_ligne_allocations bla ON bla.id=s.bl_allocation_id JOIN bon_livraison_ligne line ON line.id=bla.bon_livraison_ligne_id JOIN bon_livraison bl ON bl.id=line.bon_livraison_id
      WHERE bl.client_id=$1 AND bl.statut IN('SHIPPED','DELIVERED') AND bl.date_expedition BETWEEN $3::date AND $4::date
        AND EXISTS(SELECT 1 FROM client_portal_delivery_site_bindings b WHERE b.account_id=$2::uuid AND b.delivery_address_id=bl.adresse_livraison_id)
    ), totals AS (SELECT x.bon_livraison_ligne_id,sum(x.quantity_received) quantity_received FROM client_portal_delivery_receipt_lines x GROUP BY x.bon_livraison_ligne_id), completed AS (
      SELECT DISTINCT ON(x.bon_livraison_ligne_id) x.bon_livraison_ligne_id,r.delivered_at FROM client_portal_delivery_receipt_lines x JOIN client_portal_delivery_receipts r ON r.id=x.receipt_id ORDER BY x.bon_livraison_ligne_id,r.created_at DESC,r.id DESC)
    , allocation_totals AS (SELECT a.bon_livraison_ligne_allocation_id,sum(a.quantity_received) quantity_received FROM client_portal_delivery_receipt_allocations a GROUP BY a.bon_livraison_ligne_allocation_id), allocation_completed AS (
      SELECT DISTINCT ON(a.bon_livraison_ligne_allocation_id) a.bon_livraison_ligne_allocation_id,r.delivered_at FROM client_portal_delivery_receipt_allocations a JOIN client_portal_delivery_receipts r ON r.id=a.receipt_id ORDER BY a.bon_livraison_ligne_allocation_id,r.created_at DESC,r.id DESC)
    SELECT s.bl_id::text,s.bl_allocation_id::text,s.bl_line_id::text,s.shipment_quantity::text,s.initial_due_date::text,s.due_date_at_shipment::text,s.departure_due_date_at_shipment::text,s.date_expedition::text,
      COALESCE(at.quantity_received,t.quantity_received,0)::text receipt_quantity,
      CASE WHEN COALESCE(at.quantity_received,t.quantity_received,0)>=s.shipment_quantity THEN COALESCE(ac.delivered_at,c.delivered_at)::text ELSE NULL END receipt_completed_at,(s.allocation_count=1 OR at.bon_livraison_ligne_allocation_id IS NOT NULL) receipt_mapping_is_unambiguous
    FROM scoped s LEFT JOIN totals t ON t.bon_livraison_ligne_id=s.bl_line_id LEFT JOIN completed c ON c.bon_livraison_ligne_id=s.bl_line_id LEFT JOIN allocation_totals at ON at.bon_livraison_ligne_allocation_id=s.bl_allocation_id LEFT JOIN allocation_completed ac ON ac.bon_livraison_ligne_allocation_id=s.bl_allocation_id`,
    [identity.clientId, identity.accountId, from, to],
  );
  const items = deliveries.rows.map((row) => {
    const lines = Array.isArray(row.lines) ? row.lines : [];
    const complete =
      lines.length > 0 &&
      lines.every(
        (line: { quantity_remaining: unknown }) =>
          n(line.quantity_remaining) <= 0,
      );
    const receiptDates = evidence.rows
      .filter((value) => value.bl_id === row.id)
      .map((value) => value.receipt_completed_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      ...row,
      lines,
      actual_delivery_date: complete ? (receiptDates.at(-1) ?? null) : null,
      receipt_state: complete
        ? "CONFIRMED"
        : row.arrival_proof_count
          ? "PARTIAL"
          : "MISSING",
    };
  });
  const confirmed = items.filter((item) => item.receipt_state === "CONFIRMED");
  const overdue = await pool.query(
    `SELECT root.id::text root_id,part.id::text part_id,part.quantity::text,part.due_date::text
    FROM delivery_promise_roots root JOIN delivery_promise_parts part ON part.root_id=root.id AND part.retired_at IS NULL
    JOIN delivery_promise_site_evidence site ON site.root_id=root.id
    JOIN commande_client order_header ON order_header.id=root.commande_id
    WHERE order_header.client_id=$1 AND site.delivery_address_id IN (SELECT binding.delivery_address_id FROM client_portal_delivery_site_bindings binding WHERE binding.account_id=$2::uuid)
      AND part.due_date<$3::date AND part.quantity>COALESCE((SELECT sum(shipment.quantity) FROM delivery_promise_shipments shipment WHERE shipment.part_id=part.id),0)
    ORDER BY part.due_date,part.id`,
    [identity.clientId, identity.accountId, to],
  );
  return {
    period: { from, to },
    source: [
      "bon_livraison",
      "delivery_promise_roots",
      "delivery_promise_shipments",
      "client_portal_delivery_receipts",
    ],
    dispatched_count: items.length,
    receipt_confirmed_count: confirmed.length,
    receipt_pending_count: items.length - confirmed.length,
    receipt_rate: items.length ? confirmed.length / items.length : null,
    service: projectPortalDeliveryServiceKpis(evidence.rows),
    unshipped_overdue_parts: overdue.rows,
    unshipped_overdue_scope: "SCOPED_SITE_EVIDENCE_ONLY",
    items,
  };
}
