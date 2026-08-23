/**
 * Minimal database double for the creation-side authoritative-PDF outbox.
 * It models the archive row returned by the new same-transaction enqueue,
 * while deliberately leaving every unrelated query to the owning fixture.
 */
export function authoritativePdfQueueDbMock(sql: unknown, params: readonly unknown[] = []) {
  const statement = String(sql);
  if (statement.includes("FROM public.commande_client cc") && statement.includes("LEFT JOIN public.clients c") && statement.includes("FOR UPDATE")) {
    const id = String(params[0] ?? "123");
    return { rows: [{ id, numero: `CC-${id}`, client_id: "001", client_name: "ACME", billing_address_id: null, billing_address_name: null, billing_street: null, billing_house_number: null, billing_postal_code: null, billing_city: null, billing_country: null, date_commande: "2026-08-23", order_type: "FERME", total_ht: 0, total_ttc: 0, remise_globale: 0, commentaire: null, updated_at: "2026-08-23T12:00:00.000Z" }], rowCount: 1 };
  }
  if (statement.includes("FROM public.ordres_fabrication o") && statement.includes("o.parent_of_id IS NULL") && statement.includes("FOR UPDATE")) {
    const id = String(params[0] ?? "9");
    return { rows: [{ id, numero: `OF-${id}`, root_of_id: null, parent_of_id: null, generation_level: 0, piece_technique_id: null, piece_technique_version_id: null, technical_snapshot_sha256: null, commande_id: "123", affaire_id: "7", client_id: "001", client_name: "ACME", quantite_lancee: 1, statut: "PLANIFIE", priority: "NORMAL", date_lancement_prevue: null, date_fin_prevue: null, updated_at: "2026-08-23T12:00:00.000Z" }], rowCount: 1 };
  }
  if (statement.includes("FROM public.of_operations")) return { rows: [], rowCount: 0 };
  if (statement.includes("FROM public.affaire a") && statement.includes("FOR UPDATE")) {
    const id = String(params[0] ?? "7");
    return { rows: [{ id, reference: `AFF-${id}`, statut: "OUVERTE", type_affaire: "LIVRAISON", date_ouverture: null, updated_at: "2026-08-23T12:00:00.000Z", client_id: "001", client_name: "ACME", commande_id: "123", commande_numero: "CC-123", devis_id: null }], rowCount: 1 };
  }
  if (statement.includes("INSERT INTO public.authoritative_pdf_archives")) {
    return {
      rows: [{
        id: "99999999-9999-4999-8999-999999999999",
        entity_type: String(params[0]), entity_id: String(params[1]), document_kind: String(params[2]),
        document_version: Number(params[3]), render_version: String(params[4]), idempotency_key: String(params[5]),
        title: String(params[6]), original_name: String(params[7]), source_snapshot: JSON.parse(String(params[8])),
        source_revision: String(params[9]), snapshot_sha256: String(params[10]), pdf_sha256: null,
        pdf_size_bytes: null, ged_document_id: null, ged_version_id: null, archived_at: null,
        created_at: "2026-08-23T12:00:00.000Z", created_by: params[11] == null ? null : Number(params[11]),
      }], rowCount: 1,
    };
  }
  if (statement.includes("INSERT INTO public.authoritative_pdf_archive_outbox")) {
    return { rows: [], rowCount: 1 };
  }
  return null;
}
