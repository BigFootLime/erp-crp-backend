import type { PoolClient } from "pg";

import { authoritativePdfFilename } from "../../../shared/authoritative-documents/authoritative-document.filename";
import type { AuthoritativePdfArchiveRecord, AuthoritativePdfCreationInput } from "../../../shared/authoritative-documents/authoritative-document.types";
import { buildInternalCreationSnapshot } from "../../../shared/authoritative-documents/internal-creation-snapshot";
import { pickMention, type LegalParty } from "../../../shared/pdf/legal-mentions";
import { renderBonLivraisonDocument } from "./bon-livraison-document";

type Queryable = Pick<PoolClient, "query">;

type DeliverySnapshot = {
  numero: string; statut: string; client_name: string; commande_numero: string | null; affaire_reference: string | null;
  address_label: string | null; date_creation: string; date_expedition: string | null; transporteur: string | null;
  tracking_number: string | null; commentaire_client: string | null; updated_at: string;
  /** Issuer terms are source data too: a later legal-profile edit must not alter an issued BL. */
  issuer: LegalParty;
  lines: Array<{ ordre: number; designation: string; code_piece: string | null; quantite: number; unite: string | null; delai_client: string | null; lot_codes: string[] }>;
};

/**
 * Read the issuer through the caller's transaction so the legal identity belongs to
 * the same serializable snapshot as the delivery. The legacy fallback mirrors the
 * shared issuer adapter for installations where the versioned function is not yet
 * available, without allowing a later worker run to read live company data.
 */
async function loadIssuerSnapshot(tx: Queryable, at: string | null): Promise<LegalParty> {
  // Do not probe the function by calling it: an undefined function aborts the
  // surrounding CREATE/SHIP transaction in PostgreSQL, making a fallback
  // impossible. `to_regprocedure` is a non-throwing catalog lookup.
  const functionLookup = await tx.query<{ function_name: string | null }>(
    `SELECT to_regprocedure('public.fn_finance_issuer_snapshot(uuid,date)')::text AS function_name`
  );
  if (functionLookup.rows[0]?.function_name) {
    const result = await tx.query<{ party: LegalParty | null }>(
      `SELECT public.fn_finance_issuer_snapshot(f.biller_id, $1::date) AS party
         FROM public.factureur f
        ORDER BY f.biller_id ASC
        LIMIT 1`,
      [at ? at.slice(0, 10) : null]
    );
    return result.rows[0]?.party ?? {};
  }
  const fallback = await tx.query<{ party: LegalParty | null }>(
    `SELECT jsonb_strip_nulls(jsonb_build_object(
        'biller_id', f.biller_id, 'company_name', f.biller_name,
        'address_line_1', NULLIF(btrim(concat_ws(' ', f.house_number, f.street)), ''),
        'postal_code', f.postal_code, 'city', f.city, 'country', f.country,
        'phone', f.phone, 'email', f.email, 'bank_name', f.default_bank_name,
        'iban', f.default_iban, 'bic', f.default_bic
      )) AS party
       FROM public.factureur f
      ORDER BY f.biller_id ASC
      LIMIT 1`
  );
  return fallback.rows[0]?.party ?? {};
}

/** Reads only persisted delivery data while the business transaction still owns its lock. */
export async function loadDeliveryAuthoritativeSnapshot(tx: Queryable, deliveryId: string): Promise<DeliverySnapshot> {
  const header = await tx.query<Omit<DeliverySnapshot, "lines" | "issuer">>(`
    SELECT bl.numero, bl.statut::text, c.company_name AS client_name, cc.numero AS commande_numero,
      a.reference AS affaire_reference,
      concat_ws(E'\\n', al.name, concat_ws(' ', al.street, al.house_number), concat_ws(' ', al.postal_code, al.city), al.country) AS address_label,
      bl.date_creation::text, bl.date_expedition::text, bl.transporteur, bl.tracking_number, bl.commentaire_client, bl.updated_at::text
    FROM public.bon_livraison bl
    JOIN public.clients c ON c.client_id = bl.client_id
    LEFT JOIN public.commande_client cc ON cc.id = bl.commande_id
    LEFT JOIN public.affaire a ON a.id = bl.affaire_id
    LEFT JOIN public.adresse_livraison al ON al.delivery_address_id = bl.adresse_livraison_id
    WHERE bl.id = $1::uuid`, [deliveryId]);
  const row = header.rows[0];
  if (!row) throw new Error("DELIVERY_AUTHORITATIVE_SNAPSHOT_NOT_FOUND");
  const lines = await tx.query<DeliverySnapshot["lines"][number]>(`
    SELECT line.ordre, line.designation, line.code_piece, line.quantite::float8 AS quantite, line.unite, line.delai_client::text,
      COALESCE(array_agg(DISTINCT lot.lot_code) FILTER (WHERE lot.lot_code IS NOT NULL), ARRAY[]::text[]) AS lot_codes
    FROM public.bon_livraison_ligne line
    LEFT JOIN public.bon_livraison_ligne_allocations allocation ON allocation.bon_livraison_ligne_id = line.id
    LEFT JOIN public.lots lot ON lot.id = allocation.lot_id
    WHERE line.bon_livraison_id = $1::uuid
    GROUP BY line.id, line.ordre, line.designation, line.code_piece, line.quantite, line.unite, line.delai_client
    ORDER BY line.ordre, line.id`, [deliveryId]);
  const issuer = await loadIssuerSnapshot(tx, row.date_expedition ?? row.date_creation);
  return {
    ...row,
    issuer,
    lines: lines.rows.map((line) => ({ ...line, lot_codes: Array.isArray(line.lot_codes) ? line.lot_codes : [] })),
  };
}

export async function buildDeliveryCreationSnapshotInput(tx: Queryable, input: { deliveryId: string; actorUserId: number | null }): Promise<AuthoritativePdfCreationInput> {
  const snapshot = await loadDeliveryAuthoritativeSnapshot(tx, input.deliveryId);
  return {
    entityType: "bon-livraison", entityId: input.deliveryId, documentKind: "DELIVERY_NOTE_CREATION_SNAPSHOT", documentVersion: 1,
    renderVersion: "internal-creation-snapshot-v1", idempotencyKey: `delivery:${input.deliveryId}:creation:v1`,
    title: `Instantané de création — bon de livraison ${snapshot.numero}`,
    originalName: authoritativePdfFilename(["bon-livraison", snapshot.numero, "creation"]), sourceRevision: snapshot.updated_at,
    sourceSnapshot: buildInternalCreationSnapshot({
      entityLabel: "Bon de livraison", reference: snapshot.numero,
      summary: [{ label: "Numéro", value: snapshot.numero }, { label: "Client", value: snapshot.client_name }, { label: "Statut initial", value: snapshot.statut }],
      sections: [{ title: "Création", rows: [
        { label: "Commande", value: snapshot.commande_numero }, { label: "Affaire", value: snapshot.affaire_reference },
        { label: "Date", value: snapshot.date_creation }, { label: "Nombre de lignes", value: snapshot.lines.length },
      ] }],
    }), actorUserId: input.actorUserId,
  };
}

export async function buildShippedDeliveryArtifactInput(tx: Queryable, input: { deliveryId: string; actorUserId: number; sourceRevision: string }): Promise<AuthoritativePdfCreationInput> {
  const snapshot = await loadDeliveryAuthoritativeSnapshot(tx, input.deliveryId);
  if (snapshot.statut !== "SHIPPED") throw new Error("DELIVERY_SHIPPED_ARTIFACT_INVALID_STATE");
  return {
    entityType: "bon-livraison", entityId: input.deliveryId, documentKind: "DELIVERY_NOTE_SHIPPED", documentVersion: 1,
    renderVersion: "delivery-note-shipped-v1", idempotencyKey: `delivery:${input.deliveryId}:shipped:v1`,
    title: `Bon de livraison expédié — ${snapshot.numero}`,
    originalName: authoritativePdfFilename(["bon-livraison", snapshot.numero, "expedie"]), sourceRevision: input.sourceRevision,
    sourceSnapshot: { type: "DELIVERY_NOTE_SHIPPED_SNAPSHOT", ...snapshot }, actorUserId: input.actorUserId,
  };
}

/** Official renderer uses the exact persisted source snapshot, never current delivery rows. */
export async function renderShippedDeliveryOfficialPdf({ archive }: { archive: AuthoritativePdfArchiveRecord }): Promise<Buffer> {
  const source = archive.sourceSnapshot as Partial<DeliverySnapshot> & { type?: string };
  if (source.type !== "DELIVERY_NOTE_SHIPPED_SNAPSHOT" || !source.numero || !source.client_name || !Array.isArray(source.lines)) {
    throw new Error("DELIVERY_SHIPPED_ARTIFACT_SNAPSHOT_INVALID");
  }
  return renderBonLivraisonDocument({
    version: archive.documentVersion, company: source.issuer && typeof source.issuer === "object" ? pickMention(source.issuer, "company_name") : null,
    issuer: source.issuer && typeof source.issuer === "object" ? source.issuer : {},
    header: {
      id: archive.entityId, numero: source.numero, statut: "SHIPPED", client: { client_id: "", company_name: source.client_name },
      commande: source.commande_numero ? { id: 0, numero: source.commande_numero } : null,
      affaire: source.affaire_reference ? { id: 0, reference: source.affaire_reference } : null,
      adresse_livraison: source.address_label ? { id: "", label: source.address_label, name: null, street: null, house_number: null, postal_code: null, city: null, country: null } : null,
      date_creation: source.date_creation ?? "", date_expedition: source.date_expedition ?? null, date_livraison: null,
      transporteur: source.transporteur ?? null, tracking_number: source.tracking_number ?? null,
      commentaire_interne: null, commentaire_client: source.commentaire_client ?? null, reception_nom_signataire: null, reception_date_signature: null,
      row_version: 1, created_at: source.date_creation ?? "", updated_at: source.updated_at ?? "", created_by: null, updated_by: null,
    },
    lignes: source.lines.map((line) => ({ ordre: Number(line.ordre), designation: String(line.designation), code_piece: line.code_piece ?? null, quantite: Number(line.quantite), unite: line.unite ?? null, delai_client: line.delai_client ?? null, allocations: (line.lot_codes ?? []).map((lot_code) => ({ lot_code })) })),
  });
}
