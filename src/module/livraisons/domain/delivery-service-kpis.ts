export type DeliveryServiceKpiSource = {
  bon_livraison_id: string;
  client_id: string;
  client_name: string;
  receipt_at: string | null;
};

/**
 * Counts dispatches at BL grain. A receipt must be a RECIPIENT_ACK or an
 * EXTERNAL_SIGNATURE attached to that BL; transport evidence and a GED portal
 * acknowledgement are intentionally not treated as customer receipt evidence.
 */
export function projectDeliveryServiceKpis(
  sources: readonly DeliveryServiceKpiSource[],
) {
  const byClient = new Map<
    string,
    {
      client_id: string;
      client_name: string;
      dispatched_count: number;
      receipt_confirmed_count: number;
      pending_bon_livraison_ids: string[];
    }
  >();
  for (const source of sources) {
    const current = byClient.get(source.client_id) ?? {
      client_id: source.client_id,
      client_name: source.client_name,
      dispatched_count: 0,
      receipt_confirmed_count: 0,
      pending_bon_livraison_ids: [],
    };
    current.dispatched_count += 1;
    if (source.receipt_at) current.receipt_confirmed_count += 1;
    else current.pending_bon_livraison_ids.push(source.bon_livraison_id);
    byClient.set(source.client_id, current);
  }
  const per_client = [...byClient.values()]
    .map((value) => ({
      ...value,
      receipt_pending_count:
        value.dispatched_count - value.receipt_confirmed_count,
      receipt_rate: value.dispatched_count
        ? value.receipt_confirmed_count / value.dispatched_count
        : null,
      pending_bon_livraison_ids: value.pending_bon_livraison_ids.sort(),
    }))
    .sort(
      (left, right) =>
        left.client_name.localeCompare(right.client_name) ||
        left.client_id.localeCompare(right.client_id),
    );
  const dispatched_count = per_client.reduce(
    (sum, value) => sum + value.dispatched_count,
    0,
  );
  const receipt_confirmed_count = per_client.reduce(
    (sum, value) => sum + value.receipt_confirmed_count,
    0,
  );
  return {
    dispatched_count,
    receipt_confirmed_count,
    receipt_pending_count: dispatched_count - receipt_confirmed_count,
    receipt_rate: dispatched_count
      ? receipt_confirmed_count / dispatched_count
      : null,
    per_client,
  };
}
