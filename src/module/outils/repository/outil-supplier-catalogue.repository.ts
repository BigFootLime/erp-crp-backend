import type { PoolClient } from "pg";

import db from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { HttpError } from "../../../utils/httpError";

type Audit = { userId: number; ip: string | null; userAgent: string | null; path: string | null; pageKey: string | null; sessionId: string | null };
type Queryer = Pick<PoolClient, "query">;

async function requireSchema(q: Queryer): Promise<void> {
  const result = await q.query<{ available: boolean }>(`SELECT to_regclass('public.outillage_tool_supplier_catalogue') IS NOT NULL AS available`);
  if (!result.rows[0]?.available) throw new HttpError(503, "OUTILLAGE_SUPPLIER_OFFERS_SCHEMA_UNAVAILABLE", "Le schéma des offres fournisseur outillage n'est pas appliqué sur cette base.");
}

async function requireTool(q: Queryer, toolId: number): Promise<void> {
  const result = await q.query("SELECT 1 FROM public.gestion_outils_outil WHERE id_outil=$1", [toolId]);
  if (!result.rows[0]) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable");
}

export async function listMasterToolSuppliers(): Promise<Array<Record<string, unknown>>> {
  const result = await db.query(`SELECT f.id::text AS id, f.id::text AS value, f.nom AS label, f.code, f.nom, f.status, f.actif,
      m.id_fournisseur AS legacy_outillage_id
    FROM public.fournisseurs f
    JOIN public.fournisseur_domaine_lien dl ON dl.fournisseur_id=f.id AND dl.domaine_code='outillage'
    LEFT JOIN public.fournisseur_outillage_mapping m ON m.fournisseur_id=f.id
    WHERE f.actif=true AND f.status NOT IN ('archive','inactif')
    ORDER BY f.nom ASC`);
  return result.rows;
}

export async function listToolSupplierOffers(toolId: number): Promise<Array<Record<string, unknown>>> {
  await requireSchema(db);
  await requireTool(db, toolId);
  const result = await db.query(`SELECT link.id_outil, c.id::text AS catalogue_id, f.id::text AS fournisseur_id,
      f.code AS fournisseur_code, f.nom AS fournisseur_nom, c.reference_fournisseur, c.designation,
      c.unite, c.prix_unitaire::float8 AS prix_unitaire_ht, c.devise, c.valid_from::text, c.valid_to::text,
      c.delai_jours, c.moq::float8 AS moq, c.lot_achat::float8 AS lot_achat,
      link.source_document, link.source_sha256, link.source_page, link.source_rect,
      link.source_date::text, link.imported_at::text, link.tax_basis,
      'INDICATIVE_OFFER'::text AS price_kind
    FROM public.outillage_tool_supplier_catalogue link
    JOIN public.fournisseur_catalogue c ON c.id=link.catalogue_id
    JOIN public.fournisseurs f ON f.id=c.fournisseur_id
    WHERE link.id_outil=$1 AND c.type='OUTILLAGE' AND c.actif=true
    ORDER BY f.nom, c.reference_fournisseur NULLS LAST, c.designation`, [toolId]);
  const indicative = await listPrintedCataloguePrices(db, toolId);
  return result.rows.map((row) => ({ ...row, indicative_catalogue_price: indicative.find((price) => price.catalogue_id === row.catalogue_id) ?? null }));
}

async function listPrintedCataloguePrices(q: Queryer, toolId: number): Promise<Array<Record<string, unknown>>> {
  const schema = await q.query<{ available: boolean }>("SELECT to_regclass('public.outillage_tool_indicative_catalogue_price') IS NOT NULL AS available");
  if (!schema.rows[0]?.available) return [];
  const result = await q.query(`SELECT p.id::text, p.id_outil, p.catalogue_id::text, c.fournisseur_id::text,
      f.nom AS fournisseur_nom, c.reference_fournisseur, p.unit_price::float8 AS unit_price, p.currency, p.unit,
      p.price_type, p.source_document, p.source_sha256, p.source_page, p.source_rect, p.source_coordinate_system,
      p.source_date::text, p.tax_basis, p.imported_at::text
    FROM public.outillage_tool_indicative_catalogue_price p
    JOIN public.fournisseur_catalogue c ON c.id=p.catalogue_id
    JOIN public.fournisseurs f ON f.id=c.fournisseur_id
    WHERE p.id_outil=$1 ORDER BY p.imported_at DESC, p.id`, [toolId]);
  return result.rows;
}

export async function linkToolSupplierOffer(toolId: number, catalogueId: string, source: { document: string; sha256: string; page: number; rect: number[]; source_date?: string | null; tax_basis: "HT" | "UNKNOWN" } | { kind: "MANUAL"; note: string }, audit: Audit): Promise<Record<string, unknown>> {
  const client = await db.connect();
  return withRealtimeOutboxTransaction(client, async () => {
    await requireSchema(client);
    await requireTool(client, toolId);
    const candidate = await client.query<{ catalogue_id: string }>(`SELECT c.id::text AS catalogue_id
      FROM public.fournisseur_catalogue c
      JOIN public.fournisseurs f ON f.id=c.fournisseur_id AND f.actif=true AND f.status NOT IN ('archive','inactif')
      JOIN public.fournisseur_domaine_lien dl ON dl.fournisseur_id=f.id AND dl.domaine_code='outillage'
      WHERE c.id=$1::uuid AND c.type='OUTILLAGE' AND c.actif=true FOR KEY SHARE`, [catalogueId]);
    if (!candidate.rows[0]) throw new HttpError(422, "OUTILLAGE_SUPPLIER_CATALOGUE_INVALID", "La référence fournisseur doit être une offre OUTILLAGE active d'un fournisseur maître Outillage.");
    const masterLink = await client.query(`INSERT INTO public.outillage_tool_fournisseur_master(id_outil,fournisseur_id)
      SELECT $1,fournisseur_id FROM public.fournisseur_catalogue WHERE id=$2::uuid ON CONFLICT DO NOTHING RETURNING created_at::text`, [toolId, catalogueId]);
    const pdf = "document" in source ? source : null;
    const sourceDate = pdf?.source_date ?? null;
    const taxBasis = pdf?.tax_basis ?? "UNKNOWN";
    const catalogueLink = await client.query(`INSERT INTO public.outillage_tool_supplier_catalogue
      (id_outil,catalogue_id,source_document,source_sha256,source_page,source_rect,source_date,tax_basis,created_by,source_kind,source_note)
      VALUES($1,$2::uuid,$3,$4,$5,$6::jsonb,$7::date,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING created_at::text`,
      [toolId, catalogueId, pdf?.document ?? null, pdf?.sha256.toLowerCase() ?? null, pdf?.page ?? null, pdf ? JSON.stringify(pdf.rect) : null, sourceDate, taxBasis, audit.userId, pdf ? "CATALOGUE_PDF" : "MANUAL", "note" in source ? source.note : null]);
    if (!masterLink.rows[0] && !catalogueLink.rows[0]) {
      return (await listToolSupplierOffersWith(client, toolId)).find((row) => row.catalogue_id === catalogueId) ?? { id_outil: toolId, catalogue_id: catalogueId };
    }
    await repoInsertAuditLog({ user_id: audit.userId, tx: client, ip: audit.ip, user_agent: audit.userAgent, device_type: null, os: null, browser: null,
      body: { event_type: "ACTION", action: "outillage.supplier-offer.link", page_key: audit.pageKey, entity_type: "OUTIL", entity_id: String(toolId), path: audit.path, client_session_id: audit.sessionId, details: { catalogue_id: catalogueId, price_kind: "INDICATIVE_OFFER", source_date: sourceDate, tax_basis: taxBasis, source_kind: pdf ? "CATALOGUE_PDF" : "MANUAL", source_note: "note" in source ? source.note : null } } });
    await enqueueEntityChanged(client, { entityType: "OUTIL", entityId: String(toolId), action: "updated", module: "outillage", at: new Date().toISOString(), invalidateKeys: ["outils", "outil-pricing", "outils-fournisseurs"] }, { deduplicationKey: `outillage:tool:${toolId}:supplier-catalogue:${catalogueId}:${catalogueLink.rows[0]?.created_at ?? masterLink.rows[0]?.created_at}` });
    const offers = await listToolSupplierOffersWith(client, toolId);
    return offers.find((row) => row.catalogue_id === catalogueId) ?? { id_outil: toolId, catalogue_id: catalogueId };
  });
}

async function listToolSupplierOffersWith(q: Queryer, toolId: number): Promise<Array<Record<string, unknown>>> {
  const result = await q.query(`SELECT link.id_outil, c.id::text AS catalogue_id, f.id::text AS fournisseur_id, f.nom AS fournisseur_nom,
      c.reference_fournisseur, c.designation, c.unite, c.prix_unitaire::float8 AS prix_unitaire_ht, c.devise,
      c.valid_from::text, c.valid_to::text, link.source_document, link.source_sha256, link.source_page, link.source_rect,
      link.source_date::text, link.imported_at::text, link.tax_basis, 'INDICATIVE_OFFER'::text AS price_kind
    FROM public.outillage_tool_supplier_catalogue link JOIN public.fournisseur_catalogue c ON c.id=link.catalogue_id
    JOIN public.fournisseurs f ON f.id=c.fournisseur_id WHERE link.id_outil=$1`, [toolId]);
  return result.rows;
}

export async function listToolIndicativePriceHistory(toolId: number): Promise<Record<string, Array<Record<string, unknown>>>> {
  await requireSchema(db); await requireTool(db, toolId);
  const indicative = await db.query(`SELECT c.id::text AS catalogue_id, f.id::text AS fournisseur_id, f.nom AS fournisseur_nom,
      c.reference_fournisseur, c.unite, h.prix_unitaire::float8 AS prix_unitaire_ht, h.devise,
      h.valid_from::text, h.recorded_at::text AS recorded_at, link.source_document, link.source_sha256, link.source_page,
      link.source_rect, link.source_date::text, link.imported_at::text, link.tax_basis, 'INDICATIVE_OFFER'::text AS price_kind
    FROM public.outillage_tool_supplier_catalogue link
    JOIN public.fournisseur_catalogue c ON c.id=link.catalogue_id
    JOIN public.fournisseurs f ON f.id=c.fournisseur_id
    JOIN public.fournisseur_catalogue_prix_history h ON h.catalogue_id=c.id
    WHERE link.id_outil=$1 AND c.type='OUTILLAGE'
    ORDER BY h.recorded_at DESC, c.id`, [toolId]);
  const actual = await db.query(`SELECT p.id::text AS id, p.id_outil, p.fournisseur_id::text, f.nom AS fournisseur_nom,
      p.prix_unitaire_ht::float8, p.quantite, p.devise, p.unite, p.purchased_at::text, p.purchase_source_ref,
      'ACTUAL_PURCHASE'::text AS price_kind FROM public.outillage_tool_actual_purchase_prices p
      JOIN public.fournisseurs f ON f.id=p.fournisseur_id WHERE p.id_outil=$1 ORDER BY p.purchased_at DESC`, [toolId]);
  return { indicative_offers: indicative.rows, indicative_catalogue_prices: await listPrintedCataloguePrices(db, toolId), actual_purchase_prices: actual.rows };
}

export async function priceVariationReport(filters: { from: string; to: string; devise: string; unite: string }): Promise<Array<Record<string, unknown>>> {
  await requireSchema(db);
  const result = await db.query(`WITH comparable AS (
    SELECT p.id_outil, p.fournisseur_id, f.nom AS fournisseur_nom, p.unite, p.devise, p.prix_unitaire_ht::float8, p.purchased_at, p.created_at, p.id,
      lag(p.prix_unitaire_ht::float8) OVER (PARTITION BY p.id_outil, p.fournisseur_id, p.devise, p.unite ORDER BY p.purchased_at, p.created_at, p.id) AS prix_precedent_ht
    FROM public.outillage_tool_actual_purchase_prices p JOIN public.fournisseurs f ON f.id=p.fournisseur_id
    WHERE p.devise=$3 AND p.unite=$4 AND p.purchased_at <= $2::date
  ) SELECT comparable.id_outil, o.reference_fabricant, o.designation_outil_cnc, fournisseur_id::text AS fournisseur_id, fournisseur_nom, unite, devise,
      prix_unitaire_ht, prix_precedent_ht, (prix_unitaire_ht-prix_precedent_ht) AS variation_ht,
      CASE WHEN prix_precedent_ht=0 THEN NULL ELSE ((prix_unitaire_ht-prix_precedent_ht)/prix_precedent_ht)*100 END AS variation_pct,
      purchased_at::text AS recorded_at,
      'ACTUAL_PURCHASE'::text AS price_kind
    FROM comparable JOIN gestion_outils_outil o ON o.id_outil=comparable.id_outil WHERE prix_precedent_ht IS NOT NULL AND purchased_at >= $1::date ORDER BY recorded_at DESC, id_outil`, [filters.from, filters.to, filters.devise, filters.unite]);
  return result.rows;
}
