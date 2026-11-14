import type { Pool } from "pg";
import { readCommandeContractCall } from "../../client/repository/client-contract-calls.repository";
import { readLegacyAssociation } from "../../client/repository/client-contract-legacy.repository";

type IncludeFlags = {
  lignes: boolean;
  echeances: boolean;
  documents: boolean;
  historique: boolean;
  affaires: boolean;
  client: boolean;
};

type HeaderRow = {
  id: string; numero: string; client_id: string | null; devis_id: string | null;
  source_devis_version_id: string | null; creation_flow_version: number; contact_id: string | null;
  destinataire_id: string | null; adresse_facturation_id: string | null; emetteur: string | null;
  code_client: string | null; date_commande: string; arc_edi: boolean; arc_date_envoi: string | null;
  compteur_affaire_id: string | null; type_affaire: string; order_type: string; cadre_start_date: string | null;
  cadre_end_date: string | null; dest_stock_magasin_id: string | null; dest_stock_emplacement_id: string | null;
  mode_port_id: string | null; mode_reglement_id: string | null; conditions_paiement_id: number | null;
  delivery_prepayment_requirement: "NOT_REQUIRED" | "PROFORMA" | null; biller_id: string | null;
  compte_vente_id: string | null; commentaire: string | null; remise_globale: number; total_ht: number;
  total_ttc: number; created_at: string; updated_at: string; statut: string;
};

type DetailRow = Record<string, unknown> & { id: string; commande_id: string };
type AffaireRow = DetailRow & { affaire_id: string; affaire: unknown };

function includeFlags(includes: Set<string>): IncludeFlags {
  const has = (v: string) => includes.has(v);
  return { lignes: has("lignes"), echeances: has("echeances"), documents: has("documents"), historique: has("historique"), affaires: has("affaires"), client: has("client") };
}

/** Owns the aggregate customer-order detail read model and its optional includes. */
export function createCommandeDetailReadRepository(deps: {
  pool: Pool;
  normalizedCommandeStatusSql: (rawExpr: string) => string;
  toInt: (value: unknown, label?: string) => number;
  toNullableInt: (value: unknown, label?: string) => number | null;
  hasCommandeToAffaireRoleColumn: (db: Pool) => Promise<boolean>;
}) {
  const { pool, normalizedCommandeStatusSql, toInt, toNullableInt, hasCommandeToAffaireRoleColumn } = deps;

  async function repoGetCommande(id: string, includes: Set<string>) {
    const commandeId = toInt(id, "commande_id");
    const headerSql = `
    SELECT
      cc.id::text AS id,
      cc.numero,
      cc.client_id,
      cc.devis_id::text AS devis_id,
      cc.source_devis_version_id::text AS source_devis_version_id,
      cc.creation_flow_version,
      cc.contact_id::text AS contact_id,
      cc.destinataire_id::text AS destinataire_id,
      cc.adresse_facturation_id::text AS adresse_facturation_id,
      cc.emetteur,
      cc.code_client,
      cc.date_commande::text AS date_commande,
      cc.arc_edi,
      cc.arc_date_envoi::text AS arc_date_envoi,
      cc.compteur_affaire_id::text AS compteur_affaire_id,
      cc.type_affaire,
      cc.order_type,
      cc.cadre_start_date::text AS cadre_start_date,
      cc.cadre_end_date::text AS cadre_end_date,
      cc.dest_stock_magasin_id::text AS dest_stock_magasin_id,
      cc.dest_stock_emplacement_id::text AS dest_stock_emplacement_id,
      cc.mode_port_id::text AS mode_port_id,
      cc.mode_reglement_id::text AS mode_reglement_id,
      cc.conditions_paiement_id,
      cc.delivery_prepayment_requirement,
      cc.biller_id::text AS biller_id,
      cc.compte_vente_id::text AS compte_vente_id,
      cc.commentaire,
      cc.remise_globale::float8 AS remise_globale,
      cc.total_ht::float8 AS total_ht,
      cc.total_ttc::float8 AS total_ttc,
      cc.created_at::text AS created_at,
      cc.updated_at::text AS updated_at,
      ${normalizedCommandeStatusSql("st.nouveau_statut")} AS statut
    FROM commande_client cc
    LEFT JOIN LATERAL (
      SELECT ch.nouveau_statut
      FROM commande_historique ch
      WHERE ch.commande_id = cc.id
      ORDER BY ch.date_action DESC, ch.id DESC
      LIMIT 1
    ) st ON TRUE
    WHERE cc.id = $1
  `;
    const commandeRow = (await pool.query<HeaderRow>(headerSql, [commandeId])).rows[0] ?? null;
    if (!commandeRow) return null;
    const commande = {
      ...commandeRow,
      client_contract_call: await readCommandeContractCall(pool, String(commandeId)),
      client_contract_legacy: await readLegacyAssociation(pool, String(commandeId)),
      id: toInt(commandeRow.id, "commande.id"),
      devis_id: toNullableInt(commandeRow.devis_id, "commande.devis_id"),
      source_devis_version_id: toNullableInt(commandeRow.source_devis_version_id, "commande.source_devis_version_id"),
      creation_flow_version: commandeRow.creation_flow_version === 2 ? 2 : 1,
    };
    const inc = includeFlags(includes);
    const lignes = inc.lignes ? (await pool.query<DetailRow>(`
          SELECT
            cl.id::text AS id, cl.commande_id::text AS commande_id, cl.designation,
            COALESCE(a.code, cl.code_piece) AS code_piece, cl.article_id::text AS article_id,
            CASE WHEN EXISTS(SELECT 1 FROM public.client_contract_legacy_lines legacy WHERE legacy.commande_ligne_id=cl.id)
              THEN cl.piece_technique_id::text ELSE COALESCE(cl.piece_technique_id::text, a.piece_technique_id::text) END AS piece_technique_id,
            cl.piece_technique_version_id::text AS piece_technique_version_id,
            cl.source_devis_ligne_id::bigint::int AS source_devis_ligne_id, cl.source_article_devis_id::text AS source_article_devis_id,
            cl.source_dossier_devis_id::text AS source_dossier_devis_id, cl.quantite::float8 AS quantite, cl.unite,
            cl.prix_unitaire_ht::float8 AS prix_unitaire_ht, cl.sale_price_reference_at_entry::float8 AS sale_price_reference_at_entry,
            cl.sale_price_reference_source, cl.sale_price_decision, cl.sale_price_history_id::text AS sale_price_history_id,
            cl.remise_ligne::float8 AS remise_ligne, cl.taux_tva::float8 AS taux_tva, cl.delai_client::text AS delai_client,
            cl.delai_interne::text AS delai_interne, cl.total_ht::float8 AS total_ht, cl.total_ttc::float8 AS total_ttc,
            cl.devis_numero, cl.famille, cl.reconciliation_status, cl.reconciliation_sources, cl.reconciliation_decisions,
            cl.reconciliation_resolved_at::text AS reconciliation_resolved_at
          FROM commande_ligne cl
          LEFT JOIN public.articles a ON a.id = cl.article_id
          WHERE cl.commande_id = $1
          ORDER BY cl.id ASC
          `, [commandeId])).rows : [];
    const lignesOut = lignes.map((l) => ({
      ...l,
      client_contract_line_id: commande.client_contract_call?.lines.find((binding: { commande_ligne_id: string }) => binding.commande_ligne_id === String(l.id))?.contract_line_id ?? null,
      id: toInt(l.id, "lignes.id"), commande_id: toInt(l.commande_id, "lignes.commande_id"),
    }));
    const echeances = inc.echeances ? (await pool.query<DetailRow>(`
          SELECT id::text AS id, commande_id::text AS commande_id, libelle, date_echeance::text AS date_echeance,
            pourcentage::float8 AS pourcentage, montant::float8 AS montant
          FROM commande_echeance WHERE commande_id = $1 ORDER BY date_echeance ASC, id ASC
          `, [commandeId])).rows : [];
    const echeancesOut = echeances.map((e) => ({ ...e, id: toInt(e.id, "echeances.id"), commande_id: toInt(e.commande_id, "echeances.commande_id") }));
    const documents = inc.documents ? (await pool.query<DetailRow>(`
          SELECT cd.id::text AS id, cd.commande_id::text AS commande_id, cd.document_id::text AS document_id, cd.type,
            CASE WHEN dc.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', dc.id::text, 'document_name', dc.document_name, 'type', dc.type,
              'creation_date', dc.creation_date::text, 'created_by', dc.created_by) END AS document
          FROM commande_documents cd LEFT JOIN documents_clients dc ON dc.id = cd.document_id
          WHERE cd.commande_id = $1 ORDER BY cd.id DESC
          `, [commandeId])).rows : [];
    const documentsOut = documents.map((d) => ({ ...d, id: toInt(d.id, "documents.id"), commande_id: toInt(d.commande_id, "documents.commande_id") }));
    const historique = inc.historique ? (await pool.query<DetailRow>(`
          SELECT id::text AS id, commande_id::text AS commande_id, user_id, date_action::text AS date_action,
            ancien_statut, nouveau_statut, commentaire
          FROM commande_historique WHERE commande_id = $1 ORDER BY date_action DESC, id DESC
          `, [commandeId])).rows : [];
    const historiqueOut = historique.map((h) => ({ ...h, id: toInt(h.id, "historique.id"), commande_id: toInt(h.commande_id, "historique.commande_id"), user_id: toNullableInt(h.user_id, "historique.user_id") }));
    let affaires: AffaireRow[] = [];
    if (inc.affaires) {
      const hasRoleColumn = await hasCommandeToAffaireRoleColumn(pool);
      const roleSql = hasRoleColumn ? "cta.role AS role" : `
        CASE
          WHEN row_number() OVER (PARTITION BY cta.commande_id ORDER BY cta.id ASC) = 1 THEN 'LIVRAISON'
          WHEN row_number() OVER (PARTITION BY cta.commande_id ORDER BY cta.id ASC) = 2 THEN 'PRODUCTION'
          ELSE NULL
        END AS role
      `;
      affaires = (await pool.query<AffaireRow>(`
         SELECT cta.id::text AS id, cta.commande_id::text AS commande_id, cta.affaire_id::text AS affaire_id,
           cta.date_conversion::text AS date_conversion, cta.commentaire, ${roleSql},
           jsonb_build_object(
             'id', a.id, 'reference', a.reference, 'client_id', a.client_id, 'commande_id', a.commande_id,
            'devis_id', a.devis_id, 'type_affaire', a.type_affaire, 'statut', a.statut,
            'date_ouverture', a.date_ouverture::text, 'date_cloture', a.date_cloture::text,
            'commentaire', a.commentaire, 'created_at', a.created_at::text, 'updated_at', a.updated_at::text) AS affaire
        FROM commande_to_affaire cta JOIN affaire a ON a.id = cta.affaire_id
        WHERE cta.commande_id = $1 ORDER BY cta.date_conversion DESC, cta.id DESC
        `, [commandeId])).rows;
    }
    const affairesOut = affaires.map((a) => {
      const affaireValue: unknown = a.affaire;
      const affaireOut = affaireValue && typeof affaireValue === "object" && !Array.isArray(affaireValue)
        ? (() => { const rec = affaireValue as Record<string, unknown>; return { ...rec, id: toInt(rec.id, "affaires.affaire.id"), commande_id: toNullableInt(rec.commande_id, "affaires.affaire.commande_id"), devis_id: toNullableInt(rec.devis_id, "affaires.affaire.devis_id") }; })()
        : affaireValue;
      return { ...a, id: toInt(a.id, "affaires.id"), commande_id: toInt(a.commande_id, "affaires.commande_id"), affaire_id: toInt(a.affaire_id, "affaires.affaire_id"), affaire: affaireOut };
    });
    const client = inc.client ? commande.client_id ? (await pool.query(`
            SELECT client_id, company_name, email, phone, delivery_address_id::text AS delivery_address_id,
              bill_address_id::text AS bill_address_id FROM clients WHERE client_id = $1
            `, [commande.client_id])).rows[0] ?? null : null : null;
    return { commande, lignes: lignesOut, echeances: echeancesOut, documents: documentsOut, historique: historiqueOut, affaires: affairesOut, client };
  }

  return { repoGetCommande };
}
