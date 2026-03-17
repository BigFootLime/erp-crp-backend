import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { buildPublicImageUrl, normalizeStoredImagePath } from "../../../utils/imageStorage";
import type {
  OutilDetail,
  OutilListItem,
  OutilPricingResponse,
  OutilPriceHistoryEntry,
  OutilStockMovement,
  OutilSupplierPriceSummary,
  OutilValeurArete,
} from "../types/outil.types";
import type { CreateOutilInput, UpdateOutilInput } from "../validators/outil.validator";

type OutilFilters = {
  id_famille?: number;
  id_geometrie?: number;
  q?: string;
  only_in_stock?: boolean;
  limit?: number;
  offset?: number;
};

type LogMouvementPayload = {
  id_outil: number;
  quantite: number;
  type: string; // 'sortie' | 'entrée' | 'inventaire' | ...
  utilisateur: string;

  // champs enrichis (si colonnes ajoutées via migration BDD)
  user_id?: number | null;
  reason?: string | null;
  source?: string | null; // 'scan' | 'manual' | ...
  note?: string | null;
  affaire_id?: number | null;
  id_fournisseur?: number | null;
  prix_unitaire?: number | null;
};

type DbClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  release?: () => void;
};

function asNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown, fallback = 0) {
  const parsed = asNullableNumber(value);
  return parsed === null ? fallback : Math.trunc(parsed);
}

function mapOutilListItem(row: Record<string, unknown>): OutilListItem {
  return {
    id_outil: asInteger(row.id_outil),
    id_fabricant: asNullableNumber(row.id_fabricant),
    id_famille: asNullableNumber(row.id_famille),
    id_geometrie: asNullableNumber(row.id_geometrie),
    reference_fabricant: asNullableString(row.reference_fabricant),
    designation_outil_cnc: asNullableString(row.designation_outil_cnc),
    codification: asNullableString(row.codification),
    nom_fabricant: asNullableString(row.nom_fabricant),
    nom_famille: asNullableString(row.nom_famille),
    nom_geometrie: asNullableString(row.nom_geometrie),
    image: buildPublicImageUrl(asNullableString(row.image)),
    image_path: buildPublicImageUrl(asNullableString(row.image_path)),
    plan: buildPublicImageUrl(asNullableString(row.plan)),
    esquisse: buildPublicImageUrl(asNullableString(row.esquisse)),
    profondeur_utile: asNullableString(row.profondeur_utile),
    matiere_usiner: asNullableString(row.matiere_usiner),
    utilisation: asNullableString(row.utilisation),
    longueur_coupe: asNullableNumber(row.longueur_coupe),
    longueur_detalonnee: asNullableNumber(row.longueur_detalonnee),
    longueur_totale: asNullableNumber(row.longueur_totale),
    diametre_nominal: asNullableNumber(row.diametre_nominal),
    diametre_queue: asNullableNumber(row.diametre_queue),
    diametre_trou: asNullableNumber(row.diametre_trou),
    diametre_detalonnee: asNullableNumber(row.diametre_detalonnee),
    angle_helice: asNullableNumber(row.angle_helice),
    angle_pointe: asNullableNumber(row.angle_pointe),
    angle_filetage: asNullableNumber(row.angle_filetage),
    norme_filetage: asNullableString(row.norme_filetage),
    pas_filetage: asNullableNumber(row.pas_filetage),
    type_arrosage: asNullableString(row.type_arrosage),
    type_entree: asNullableString(row.type_entree),
    nombre_dents: asNullableNumber(row.nombre_dents),
    quantite_stock: asInteger(row.quantite_stock),
    quantite_minimale: asInteger(row.quantite_minimale),
  };
}

function mapStockMovement(row: Record<string, unknown>): OutilStockMovement {
  return {
    id_mouvement: asInteger(row.id_mouvement),
    type_mouvement: asNullableString(row.type_mouvement),
    quantite: asInteger(row.quantite),
    date_mouvement: asNullableString(row.date_mouvement),
    utilisateur: asNullableString(row.utilisateur),
    user_id: asNullableNumber(row.user_id),
    reason: asNullableString(row.reason),
    source: asNullableString(row.source),
    note: asNullableString(row.note),
    commentaire: asNullableString(row.commentaire),
    affaire_id: asNullableNumber(row.affaire_id),
    id_fournisseur: asNullableNumber(row.id_fournisseur),
    fournisseur_nom: asNullableString(row.fournisseur_nom),
    prix_unitaire: asNullableNumber(row.prix_unitaire),
  };
}

function mapPriceHistoryEntry(row: Record<string, unknown>): OutilPriceHistoryEntry {
  return {
    id_historique: asInteger(row.id_historique),
    id_outil: asNullableNumber(row.id_outil),
    id_fournisseur: asNullableNumber(row.id_fournisseur),
    fournisseur_nom: asNullableString(row.fournisseur_nom),
    date_prix: asNullableString(row.date_prix),
    prix: asNullableNumber(row.prix) ?? 0,
  };
}

function mapSupplierSummary(row: Record<string, unknown>): OutilSupplierPriceSummary {
  return {
    id_fournisseur: asInteger(row.id_fournisseur),
    fournisseur_nom: asNullableString(row.fournisseur_nom) ?? "Fournisseur inconnu",
    transactions_count: asInteger(row.transactions_count),
    min_price: asNullableNumber(row.min_price),
    max_price: asNullableNumber(row.max_price),
    avg_price: asNullableNumber(row.avg_price),
    last_price: asNullableNumber(row.last_price),
    last_price_date: asNullableString(row.last_price_date),
  };
}

function isUndefinedColumnError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "42703";
}

async function getOutilBaseRow(client: DbClient, id: number) {
  const result = await client.query(
    `
      SELECT
        o.*,
        f.name AS nom_fabricant,
        fam.nom_famille,
        fam.image_path AS famille_image_path,
        g.nom_geometrie,
        g.image_path,
        COALESCE(s.quantite, 0)::int AS quantite_stock,
        COALESCE(s.quantite_minimale, 0)::int AS quantite_minimale
      FROM gestion_outils_outil o
      LEFT JOIN gestion_outils_fabricant f ON o.id_fabricant = f.id_fabricant
      LEFT JOIN gestion_outils_famille fam ON o.id_famille = fam.id_famille
      LEFT JOIN gestion_outils_geometrie g ON o.id_geometrie = g.id_geometrie
      LEFT JOIN gestion_outils_stock s ON o.id_outil = s.id_outil
      WHERE o.id_outil = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export const outilRepository = {
  async exists(id: number) {
    const result = await db.query(`SELECT 1 AS ok FROM gestion_outils_outil WHERE id_outil = $1 LIMIT 1`, [id]);
    return Boolean(result.rows[0]);
  },

  // 🔍 Trouver un outil par son ID
  async findById(id: number) {
    const baseRow = await getOutilBaseRow(db, id);
    if (!baseRow) return null;

    const [fournisseurs, revetements, valeursAretes, recentMovements] = await Promise.all([
      db.query(
        `
          SELECT f.id_fournisseur AS id, f.nom AS label
          FROM gestion_outils_outil_fournisseur oof
          JOIN gestion_outils_fournisseur f ON f.id_fournisseur = oof.id_fournisseur
          WHERE oof.id_outil = $1
          ORDER BY f.nom
        `,
        [id]
      ),
      db.query(
        `
          SELECT r.id_revetement AS id, r.nom AS label
          FROM gestion_outils_outil_revetement oor
          JOIN gestion_outils_revetement r ON r.id_revetement = oor.id_revetement
          WHERE oor.id_outil = $1
          ORDER BY r.nom
        `,
        [id]
      ),
      db.query(
        `
          SELECT
            vac.id_valeur_arete,
            vac.id_arete_coupe,
            ac.nom_arete_coupe,
            vac.valeur
          FROM gestion_outils_valeur_arete_coupe vac
          LEFT JOIN gestion_outils_arete_coupe ac ON ac.id_arete_coupe = vac.id_arete_coupe
          WHERE vac.id_outil = $1
          ORDER BY ac.nom_arete_coupe NULLS LAST, vac.id_valeur_arete
        `,
        [id]
      ),
      db.query(
        `
          SELECT
            m.id_mouvement,
            m.type_mouvement,
            m.quantite,
            m.date_mouvement::text AS date_mouvement,
            m.commentaire,
            m.utilisateur,
            m.user_id,
            m.reason,
            m.source,
            m.note,
            m.affaire_id,
            m.id_fournisseur,
            f.nom AS fournisseur_nom,
            m.prix_unitaire
          FROM gestion_outils_mouvement_stock m
          LEFT JOIN gestion_outils_fournisseur f ON f.id_fournisseur = m.id_fournisseur
          WHERE m.id_outil = $1
          ORDER BY m.date_mouvement DESC NULLS LAST, m.id_mouvement DESC
          LIMIT 50
        `,
        [id]
      ),
    ]);

    return {
      ...mapOutilListItem(baseRow),
      fournisseurs: fournisseurs.rows.map((row) => ({ id: asInteger(row.id), label: asNullableString(row.label) ?? "" })),
      revetements: revetements.rows.map((row) => ({ id: asInteger(row.id), label: asNullableString(row.label) ?? "" })),
      valeurs_aretes: valeursAretes.rows.map(
        (row) =>
          ({
            id_valeur_arete: asInteger(row.id_valeur_arete),
            id_arete_coupe: asNullableNumber(row.id_arete_coupe),
            nom_arete_coupe: asNullableString(row.nom_arete_coupe),
            valeur: asNullableNumber(row.valeur),
          }) satisfies OutilValeurArete
      ),
      recent_movements: recentMovements.rows.map(mapStockMovement),
    } satisfies OutilDetail;
  },

  // 🔍 Trouver un outil par sa référence fabricant (code barre)
  async findByReferenceFabricant(reference_fabricant: string, client?: any) {
    const dbClient = client || (await db.connect());
    let releaseClient = false;

    try {
      if (!client) releaseClient = true;

      const query = `
        SELECT 
          o.*,

          ARRAY(
            SELECT id_fournisseur
            FROM gestion_outils_outil_fournisseur
            WHERE id_outil = o.id_outil
          ) AS fournisseurs,

          ARRAY(
            SELECT id_revetement
            FROM gestion_outils_outil_revetement
            WHERE id_outil = o.id_outil
          ) AS revetements,

          ARRAY(
            SELECT json_build_object(
              'id_arete_coupe', v.id_arete_coupe,
              'valeur', v.valeur
            )
            FROM gestion_outils_valeur_arete_coupe v
            WHERE v.id_outil = o.id_outil
          ) AS valeurs_aretes

        FROM gestion_outils_outil o
        WHERE o.reference_fabricant = $1
        LIMIT 1
      `;

      const result = await dbClient.query(query, [reference_fabricant]);
      return result.rows[0] || null;
    } finally {
      if (releaseClient) dbClient.release();
    }
  },

  // 📋 Liste filtrée/paginée pour l’UI (cards)
  async findAllFiltered(filters: OutilFilters) {
    const {
      id_famille,
      id_geometrie,
      q,
      only_in_stock,
      limit = 50,
      offset = 0,
    } = filters;

    const where: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (id_famille) {
      where.push(`o.id_famille = $${idx++}`);
      params.push(id_famille);
    }

    if (id_geometrie) {
      where.push(`o.id_geometrie = $${idx++}`);
      params.push(id_geometrie);
    }

    if (q && q.trim()) {
      where.push(
        `(o.reference_fabricant ILIKE $${idx} OR o.designation_outil_cnc ILIKE $${idx} OR o.codification ILIKE $${idx})`
      );
      params.push(`%${q.trim()}%`);
      idx++;
    }

    if (only_in_stock) {
      where.push(`COALESCE(s.quantite, 0) > 0`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const result = await db.query(
      `
      SELECT
        o.*,
        f.name AS nom_fabricant,
        fam.nom_famille,
        g.nom_geometrie,
        g.image_path,
        COALESCE(s.quantite, 0) AS quantite_stock,
        COALESCE(s.quantite_minimale, 0) AS quantite_minimale
      FROM gestion_outils_outil o
      LEFT JOIN gestion_outils_fabricant f ON o.id_fabricant = f.id_fabricant
      LEFT JOIN gestion_outils_famille fam ON o.id_famille = fam.id_famille
      LEFT JOIN gestion_outils_geometrie g ON o.id_geometrie = g.id_geometrie
      LEFT JOIN gestion_outils_stock s ON o.id_outil = s.id_outil
      ${whereSql}
      ORDER BY o.id_outil DESC
      LIMIT $${idx++} OFFSET $${idx++}
      `,
      [...params, limit, offset]
    );

    return result.rows.map((row) => mapOutilListItem(row));
  },

  // 🚨 Outils sous le stock minimum
  async getLowStock() {
    const result = await db.query(`
      SELECT
        o.id_outil,
        o.reference_fabricant,
        o.designation_outil_cnc,
        fam.nom_famille,
        g.nom_geometrie,
        COALESCE(s.quantite, 0) AS quantite_stock,
        COALESCE(s.quantite_minimale, 0) AS quantite_minimale
      FROM gestion_outils_outil o
      LEFT JOIN gestion_outils_famille fam ON o.id_famille = fam.id_famille
      LEFT JOIN gestion_outils_geometrie g ON o.id_geometrie = g.id_geometrie
      LEFT JOIN gestion_outils_stock s ON o.id_outil = s.id_outil
      WHERE COALESCE(s.quantite, 0) <= COALESCE(s.quantite_minimale, 0)
      ORDER BY COALESCE(s.quantite, 0) ASC, o.id_outil DESC
    `);

    return result.rows.map((row) => ({
      ...row,
      quantite_stock: asInteger(row.quantite_stock),
      quantite_minimale: asInteger(row.quantite_minimale),
    }));
  },

  // ➕ Créer un nouvel outil + gérer les relations + init stock
  async create(
    data: CreateOutilInput & { esquisse?: string | null; plan?: string | null; image?: string | null },
    client: DbClient
  ): Promise<number> {
    const result = await client.query(
      `
      INSERT INTO gestion_outils_outil (
        id_fabricant, id_famille, id_geometrie,
        reference_fabricant, designation_outil_cnc, codification, matiere_usiner,
        profondeur_utile, utilisation,
        longueur_coupe, longueur_detalonnee, longueur_totale,
        diametre_nominal, diametre_queue, diametre_trou, diametre_detalonnee,
        angle_helice, angle_pointe, angle_filetage,
        norme_filetage, pas_filetage, type_arrosage, type_entree, nombre_dents,
        esquisse, plan, image
      )
      VALUES (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19,
        $20, $21, $22, $23, $24,
        $25, $26, $27
      )
      RETURNING id_outil
      `,
      [
        data.id_fabricant,
        data.id_famille,
        data.id_geometrie,
        data.reference_fabricant,
        data.designation_outil_cnc,
        data.codification,
        data.matiere_usiner,
        data.profondeur_utile,
        data.utilisation,
        data.longueur_coupe,
        data.longueur_detalonnee,
        data.longueur_totale,
        data.diametre_nominal,
        data.diametre_queue,
        data.diametre_trou,
        data.diametre_detalonnee,
        data.angle_helice,
        data.angle_pointe,
        data.angle_filetage,
        data.norme_filetage,
        data.pas_filetage,
        data.type_arrosage,
        data.type_entree,
        data.nombre_dents,
        normalizeStoredImagePath(data.esquisse),
        normalizeStoredImagePath(data.plan),
        normalizeStoredImagePath(data.image),
      ]
    );

    const id_outil = asInteger(result.rows[0]?.id_outil);

    // ✅ Stock initial (UPSERT)
    await this.initStock(client, id_outil, data.quantite_stock ?? 0, data.quantite_minimale ?? 0);

    // 🔗 relations
    if (data.fournisseurs?.length) await this.linkFournisseurs(client, id_outil, data.fournisseurs);
    if (data.revetements?.length) await this.linkRevetements(client, id_outil, data.revetements);
    if (data.valeurs_aretes?.length) await this.linkValeursAretes(client, id_outil, data.valeurs_aretes);

    return id_outil;
  },

  async update(
    id_outil: number,
    data: UpdateOutilInput & { esquisse?: string | null; plan?: string | null; image?: string | null },
    client: DbClient
  ) {
    const existing = await getOutilBaseRow(client, id_outil);
    if (!existing) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable");

    await client.query(
      `
        UPDATE gestion_outils_outil
        SET
          id_fabricant = $2,
          id_famille = $3,
          id_geometrie = $4,
          reference_fabricant = $5,
          designation_outil_cnc = $6,
          codification = $7,
          matiere_usiner = $8,
          profondeur_utile = $9,
          utilisation = $10,
          longueur_coupe = $11,
          longueur_detalonnee = $12,
          longueur_totale = $13,
          diametre_nominal = $14,
          diametre_queue = $15,
          diametre_trou = $16,
          diametre_detalonnee = $17,
          angle_helice = $18,
          angle_pointe = $19,
          angle_filetage = $20,
          norme_filetage = $21,
          pas_filetage = $22,
          type_arrosage = $23,
          type_entree = $24,
          nombre_dents = $25,
          esquisse = $26,
          plan = $27,
          image = $28
        WHERE id_outil = $1
      `,
      [
        id_outil,
        data.id_fabricant,
        data.id_famille,
        data.id_geometrie ?? null,
        data.reference_fabricant ?? null,
        data.designation_outil_cnc,
        data.codification,
        data.matiere_usiner ?? null,
        data.profondeur_utile ?? null,
        data.utilisation ?? null,
        data.longueur_coupe ?? null,
        data.longueur_detalonnee ?? null,
        data.longueur_totale ?? null,
        data.diametre_nominal ?? null,
        data.diametre_queue ?? null,
        data.diametre_trou ?? null,
        data.diametre_detalonnee ?? null,
        data.angle_helice ?? null,
        data.angle_pointe ?? null,
        data.angle_filetage ?? null,
        data.norme_filetage ?? null,
        data.pas_filetage ?? null,
        data.type_arrosage ?? null,
        data.type_entree ?? null,
        data.nombre_dents ?? null,
        normalizeStoredImagePath(data.esquisse ?? asNullableString(existing.esquisse)),
        normalizeStoredImagePath(data.plan ?? asNullableString(existing.plan)),
        normalizeStoredImagePath(data.image ?? asNullableString(existing.image)),
      ]
    );

    await this.initStock(client, id_outil, data.quantite_stock ?? 0, data.quantite_minimale ?? 0);
    await this.replaceFournisseurs(client, id_outil, data.fournisseurs ?? []);
    await this.replaceRevetements(client, id_outil, data.revetements ?? []);
    await this.replaceValeursAretes(client, id_outil, data.valeurs_aretes ?? []);
  },

  async delete(id_outil: number, client: DbClient) {
    const existing = await getOutilBaseRow(client, id_outil);
    if (!existing) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable");

    await client.query(`DELETE FROM gestion_outils_historique_prix WHERE id_outil = $1`, [id_outil]);
    await client.query(`DELETE FROM gestion_outils_mouvement_stock WHERE id_outil = $1`, [id_outil]);
    await client.query(`DELETE FROM gestion_outils_stock WHERE id_outil = $1`, [id_outil]);
    await client.query(`DELETE FROM gestion_outils_outil_fournisseur WHERE id_outil = $1`, [id_outil]);
    await client.query(`DELETE FROM gestion_outils_outil_revetement WHERE id_outil = $1`, [id_outil]);
    await client.query(`DELETE FROM gestion_outils_valeur_arete_coupe WHERE id_outil = $1`, [id_outil]);
    await client.query(`DELETE FROM gestion_outils_outil WHERE id_outil = $1`, [id_outil]);

    return {
      image: asNullableString(existing.image),
      plan: asNullableString(existing.plan),
      esquisse: asNullableString(existing.esquisse),
    };
  },

  // ➕ Initialiser stock (UPSERT recommandé)
  async initStock(client: DbClient, id_outil: number, quantite: number, quantite_minimale: number = 0) {
    const qte = Number(quantite ?? 0);
    const qteMin = Number(quantite_minimale ?? 0);

    // On crée une ligne stock même si 0 pour simplifier l'UI + éviter "stock introuvable"
    await client.query(
      `
      INSERT INTO gestion_outils_stock (id_outil, quantite, quantite_minimale, date_maj)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (id_outil) DO UPDATE SET
        quantite = EXCLUDED.quantite,
        quantite_minimale = EXCLUDED.quantite_minimale,
        date_maj = NOW()
      `,
      [id_outil, qte, qteMin]
    );
  },

  // ➕ Ajouter au stock
  async addToStock(client: DbClient, id_outil: number, quantite: number) {
    const qte = Number(quantite);
    if (!Number.isFinite(qte) || qte <= 0) throw new HttpError(422, "INVALID_QTY", "Quantite invalide pour l'entree stock");

    const r = await client.query(
      `
      UPDATE gestion_outils_stock
         SET quantite = quantite + $1,
             date_maj = NOW()
       WHERE id_outil = $2
      `,
      [qte, id_outil]
    );

    if (r.rowCount === 0) {
      await client.query(
        `
        INSERT INTO gestion_outils_stock (id_outil, quantite, quantite_minimale, date_maj)
        VALUES ($1, $2, 0, NOW())
        `,
        [id_outil, qte]
      );
    }
  },

  // ➖ Déduire du stock (LOCK)
  async removeFromStock(client: DbClient, id_outil: number, quantity: number) {
    const qte = Number(quantity);
    if (!Number.isFinite(qte) || qte <= 0) throw new HttpError(422, "INVALID_QTY", "Quantite invalide pour la sortie stock");

    const res = await client.query(
      `SELECT quantite FROM gestion_outils_stock WHERE id_outil = $1 FOR UPDATE`,
      [id_outil]
    );

    if (res.rowCount === 0) throw new HttpError(404, "STOCK_NOT_FOUND", "Stock introuvable pour cet outil");

    const currentStock = Number(res.rows[0].quantite);
    if (currentStock < qte) throw new HttpError(409, "INSUFFICIENT_STOCK", `Stock insuffisant pour l'outil ${id_outil}`);

    await client.query(
      `UPDATE gestion_outils_stock SET quantite = quantite - $1, date_maj = NOW() WHERE id_outil = $2`,
      [qte, id_outil]
    );
  },

  // 🧾 Ajuster stock en valeur absolue (inventaire)
  async setStockAbsolute(client: DbClient, id_outil: number, newQty: number) {
    const qty = Number(newQty);
    if (!Number.isFinite(qty) || qty < 0) throw new HttpError(422, "INVALID_QTY", "Quantite d'inventaire invalide");

    // lock
    await client.query(
      `SELECT quantite FROM gestion_outils_stock WHERE id_outil = $1 FOR UPDATE`,
      [id_outil]
    );

    const r = await client.query(
      `UPDATE gestion_outils_stock SET quantite = $1, date_maj = NOW() WHERE id_outil = $2`,
      [qty, id_outil]
    );

    if (r.rowCount === 0) {
      await client.query(
        `INSERT INTO gestion_outils_stock (id_outil, quantite, quantite_minimale, date_maj)
         VALUES ($1, $2, 0, NOW())`,
        [id_outil, qty]
      );
    }
  },

  // 💶 Historique prix
  async insertHistoriquePrix(client: DbClient, id_outil: number, prix: number, id_fournisseur: number) {
    const p = Number(prix);
    if (!Number.isFinite(p) || p < 0) throw new HttpError(422, "INVALID_PRICE", "Prix invalide");

    await client.query(
      `
      INSERT INTO gestion_outils_historique_prix (id_outil, prix, date_prix, id_fournisseur)
      VALUES ($1, $2, NOW(), $3)
      `,
      [id_outil, p, id_fournisseur]
    );
  },

  // 🧾 Journaliser un mouvement (compatible ancien schéma + nouveau schéma)
  async logMouvementStock(client: any, payload: LogMouvementPayload) {
    // On tente d'insérer avec les colonnes enrichies.
    // Si ta BDD n'a pas encore les colonnes, on fallback sur l'ancien INSERT.
    try {
      await client.query(
        `
        INSERT INTO gestion_outils_mouvement_stock
          (
            id_outil,
            quantite,
            type_mouvement,
            utilisateur,
            user_id,
            reason,
            source,
            note,
            affaire_id,
            id_fournisseur,
            prix_unitaire,
            commentaire,
            date_mouvement
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        `,
        [
          payload.id_outil,
          payload.quantite,
          payload.type,
          payload.utilisateur,
          payload.user_id ?? null,
          payload.reason ?? null,
          payload.source ?? null,
          payload.note ?? null,
          payload.affaire_id ?? null,
          payload.id_fournisseur ?? null,
          payload.prix_unitaire ?? null,
          payload.note ?? payload.reason ?? null,
        ]
      );
    } catch (err: unknown) {
      if (!isUndefinedColumnError(err)) throw err;

      // fallback ancien schéma
      await client.query(
        `
        INSERT INTO gestion_outils_mouvement_stock (id_outil, quantite, type_mouvement, utilisateur, date_mouvement)
        VALUES ($1, $2, $3, $4, NOW())
        `,
        [payload.id_outil, payload.quantite, payload.type, payload.utilisateur]
      );
    }
  },

  async replaceFournisseurs(client: DbClient, id_outil: number, fournisseurs: number[]) {
    await client.query(`DELETE FROM gestion_outils_outil_fournisseur WHERE id_outil = $1`, [id_outil]);
    await this.linkFournisseurs(client, id_outil, fournisseurs);
  },

  async replaceRevetements(client: DbClient, id_outil: number, revetements: number[]) {
    await client.query(`DELETE FROM gestion_outils_outil_revetement WHERE id_outil = $1`, [id_outil]);
    await this.linkRevetements(client, id_outil, revetements);
  },

  async replaceValeursAretes(
    client: DbClient,
    id_outil: number,
    valeurs: { id_arete_coupe: number; valeur: number }[]
  ) {
    await client.query(`DELETE FROM gestion_outils_valeur_arete_coupe WHERE id_outil = $1`, [id_outil]);
    await this.linkValeursAretes(client, id_outil, valeurs);
  },

  // 🔗 Lier fournisseurs
  async linkFournisseurs(client: any, id_outil: number, fournisseurs: number[]) {
    const queries = fournisseurs.map((fid) =>
      client.query(
        `
        INSERT INTO gestion_outils_outil_fournisseur (id_outil, id_fournisseur)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [id_outil, fid]
      )
    );
    await Promise.all(queries);
  },

  // 🔗 Lier revêtements
  async linkRevetements(client: any, id_outil: number, revetements: number[]) {
    const queries = revetements.map((rid) =>
      client.query(
        `INSERT INTO gestion_outils_outil_revetement (id_outil, id_revetement) VALUES ($1, $2)`,
        [id_outil, rid]
      )
    );
    await Promise.all(queries);
  },

  // 🔗 Lier valeurs arêtes
  async linkValeursAretes(
    client: any,
    id_outil: number,
    valeurs: { id_arete_coupe: number; valeur: number }[]
  ) {
    const queries = valeurs.map(({ id_arete_coupe, valeur }) =>
      client.query(
        `INSERT INTO gestion_outils_valeur_arete_coupe (id_outil, id_arete_coupe, valeur) VALUES ($1, $2, $3)`,
        [id_outil, id_arete_coupe, valeur]
      )
    );
    await Promise.all(queries);
  },

  // 📦 Familles
  async getFamilles() {
    const result = await db.query(
      `SELECT id_famille, nom_famille, image_path FROM gestion_outils_famille ORDER BY ordre NULLS LAST, nom_famille`
    );
    return result.rows.map((row) => ({
      value: asInteger(row.id_famille),
      label: asNullableString(row.nom_famille) ?? "",
      imagePath: buildPublicImageUrl(asNullableString(row.image_path)),
    }));
  },

  async createFamille(nom_famille: string, image_path: string | null) {
    const result = await db.query(
      `
        INSERT INTO gestion_outils_famille (nom_famille, image_path)
        VALUES ($1, $2)
        RETURNING id_famille, nom_famille, image_path
      `,
      [nom_famille, normalizeStoredImagePath(image_path)]
    );

    const row = result.rows[0];
    return {
      value: asInteger(row.id_famille),
      label: asNullableString(row.nom_famille) ?? "",
      imagePath: buildPublicImageUrl(asNullableString(row.image_path)),
    };
  },

  async updateFamille(id_famille: number, nom_famille: string, image_path?: string | null) {
    const result = await db.query(
      `
        UPDATE gestion_outils_famille
        SET
          nom_famille = $2,
          image_path = COALESCE($3, image_path)
        WHERE id_famille = $1
        RETURNING id_famille, nom_famille, image_path
      `,
      [id_famille, nom_famille, normalizeStoredImagePath(image_path)]
    );

    if (!result.rows[0]) throw new HttpError(404, "FAMILLE_NOT_FOUND", "Famille introuvable");

    const row = result.rows[0];
    return {
      value: asInteger(row.id_famille),
      label: asNullableString(row.nom_famille) ?? "",
      imagePath: buildPublicImageUrl(asNullableString(row.image_path)),
    };
  },

  // 🏭 Fabricants
  async getFabricants() {
    const result = await db.query(`SELECT id_fabricant, name FROM gestion_outils_fabricant ORDER BY name`);
    return result.rows.map((row: any) => ({ value: row.id_fabricant, label: row.name }));
  },

  async createFabricant(nom_fabricant: string, logo: string | null, id_fournisseurs: number[]) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO gestion_outils_fabricant (name, logo) VALUES ($1, $2) RETURNING id_fabricant`,
        [nom_fabricant, logo]
      );

      const id_fabricant = result.rows[0].id_fabricant;

      for (const id_fournisseur of id_fournisseurs) {
        await client.query(
          `INSERT INTO gestion_outils_fournisseur_fabricant (id_fabricant, id_fournisseur) VALUES ($1, $2)`,
          [id_fabricant, id_fournisseur]
        );
      }

      await client.query("COMMIT");
      return id_fabricant;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },

  // 🤝 Fournisseurs
  async getFournisseurs(fabricantId?: number) {
    if (fabricantId) {
      const result = await db.query(
        `
        SELECT f.id_fournisseur, f.nom
        FROM gestion_outils_fournisseur f
        INNER JOIN gestion_outils_fournisseur_fabricant ff
          ON f.id_fournisseur = ff.id_fournisseur
        WHERE ff.id_fabricant = $1
        ORDER BY f.nom
        `,
        [fabricantId]
      );

      return result.rows.map((row: any) => ({ value: row.id_fournisseur, label: row.nom }));
    }

    const result = await db.query(`SELECT id_fournisseur, nom FROM gestion_outils_fournisseur ORDER BY nom`);
    return result.rows.map((row: any) => ({ value: row.id_fournisseur, label: row.nom }));
  },

  async createFournisseur(data: any) {
    const {
      nom,
      adresse_ligne,
      house_no,
      postcode,
      city,
      country,
      phone_num,
      email,
      nom_commercial,
    } = data;

    await db.query(
      `
      INSERT INTO gestion_outils_fournisseur
        (nom, adresse_ligne, house_no, postcode, city, country, phone_num, email, nom_commercial)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [nom, adresse_ligne, house_no, postcode, city, country, phone_num, email, nom_commercial]
    );
  },

  // 🧠 Géométries (par famille)
  async getGeometries(id_famille?: number) {
    let query = "SELECT * FROM gestion_outils_geometrie";
    const values: any[] = [];

    if (id_famille) {
      query += " WHERE id_famille = $1";
      values.push(id_famille);
    }

    query += " ORDER BY ordre NULLS LAST, nom_geometrie";

    const result = await db.query(query, values);

    return result.rows.map((row) => ({
      value: asInteger(row.id_geometrie),
      label: asNullableString(row.nom_geometrie) ?? "",
      imagePath: buildPublicImageUrl(asNullableString(row.image_path)),
    }));
  },

  async createGeometrie(nom_geometrie: string, id_famille: number, image_path: string | null) {
    const result = await db.query(
      `
        INSERT INTO gestion_outils_geometrie (nom_geometrie, id_famille, image_path)
        VALUES ($1, $2, $3)
        RETURNING id_geometrie, nom_geometrie, id_famille, image_path
      `,
      [nom_geometrie, id_famille, normalizeStoredImagePath(image_path)]
    );

    const row = result.rows[0];
    return {
      value: asInteger(row.id_geometrie),
      label: asNullableString(row.nom_geometrie) ?? "",
      id_famille: asInteger(row.id_famille),
      imagePath: buildPublicImageUrl(asNullableString(row.image_path)),
    };
  },

  async updateGeometrie(id_geometrie: number, nom_geometrie: string, id_famille: number, image_path?: string | null) {
    const result = await db.query(
      `
        UPDATE gestion_outils_geometrie
        SET
          nom_geometrie = $2,
          id_famille = $3,
          image_path = COALESCE($4, image_path)
        WHERE id_geometrie = $1
        RETURNING id_geometrie, nom_geometrie, id_famille, image_path
      `,
      [id_geometrie, nom_geometrie, id_famille, normalizeStoredImagePath(image_path)]
    );

    if (!result.rows[0]) throw new HttpError(404, "GEOMETRIE_NOT_FOUND", "Geometrie introuvable");

    const row = result.rows[0];
    return {
      value: asInteger(row.id_geometrie),
      label: asNullableString(row.nom_geometrie) ?? "",
      id_famille: asInteger(row.id_famille),
      imagePath: buildPublicImageUrl(asNullableString(row.image_path)),
    };
  },

  // 🎨 Revêtements
  async getRevetements(id_fabricant?: number) {
    let query = "SELECT id_revetement, nom FROM gestion_outils_revetement";
    const params: any[] = [];

    if (id_fabricant) {
      query += " WHERE id_fabricant = $1";
      params.push(id_fabricant);
    }

    query += " ORDER BY nom";

    const result = await db.query(query, params);
    return result.rows.map((row: any) => ({ value: row.id_revetement, label: row.nom }));
  },

  async createRevetement(nom: string, id_fabricant: number) {
    const result = await db.query(
      `INSERT INTO gestion_outils_revetement (nom, id_fabricant) VALUES ($1, $2) RETURNING id_revetement`,
      [nom, id_fabricant]
    );
    return result.rows[0].id_revetement;
  },

  // 🪓 Arêtes (par géométrie)
  async getAretes(id_geometrie?: number) {
    if (id_geometrie) {
      const result = await db.query(
        `
        SELECT gac.id_arete_coupe, ac.nom_arete_coupe
        FROM gestion_outils_geometrie_aretecoupe gac
        JOIN gestion_outils_arete_coupe ac ON gac.id_arete_coupe = ac.id_arete_coupe
        WHERE gac.id_geometrie = $1
        ORDER BY ac.nom_arete_coupe
        `,
        [id_geometrie]
      );

      return result.rows.map((row: any) => ({
        value: row.id_arete_coupe.toString(),
        label: row.nom_arete_coupe,
      }));
    }

    const result = await db.query(
      `SELECT id_arete_coupe, nom_arete_coupe FROM gestion_outils_arete_coupe ORDER BY nom_arete_coupe`
    );

    return result.rows.map((row: any) => ({
      value: row.id_arete_coupe.toString(),
      label: row.nom_arete_coupe,
    }));
  },

  // 📋 Liste "full" (compat ancienne route)
  async findAll() {
    const result = await db.query(`
      SELECT
        o.*,
        f.name AS nom_fabricant,
        fam.nom_famille,
        g.nom_geometrie,
        g.image_path,
        COALESCE(s.quantite, 0) AS quantite_stock,
        COALESCE(s.quantite_minimale, 0) AS quantite_minimale
      FROM gestion_outils_outil o
      LEFT JOIN gestion_outils_fabricant f ON o.id_fabricant = f.id_fabricant
      LEFT JOIN gestion_outils_famille fam ON o.id_famille = fam.id_famille
      LEFT JOIN gestion_outils_geometrie g ON o.id_geometrie = g.id_geometrie
      LEFT JOIN gestion_outils_stock s ON o.id_outil = s.id_outil
      ORDER BY o.id_outil DESC
    `);

    return result.rows.map((row) => mapOutilListItem(row));
  },

  async getPricingAnalytics(id_outil: number): Promise<OutilPricingResponse> {
    const [historyRows, summaryRows, replenishmentRows] = await Promise.all([
      db.query(
        `
          WITH movement_events AS (
            SELECT
              NULL::int AS id_historique,
              m.id_outil,
              m.id_fournisseur,
              f.nom AS fournisseur_nom,
              m.date_mouvement::text AS date_prix,
              m.prix_unitaire AS prix,
              m.id_mouvement,
              m.quantite,
              m.source,
              m.reason,
              m.note,
              m.affaire_id,
              'movement'::text AS source_table
            FROM gestion_outils_mouvement_stock m
            LEFT JOIN gestion_outils_fournisseur f ON f.id_fournisseur = m.id_fournisseur
            WHERE m.id_outil = $1
              AND m.type_mouvement = 'entrée'
              AND m.id_fournisseur IS NOT NULL
              AND m.prix_unitaire IS NOT NULL
          ),
          history_only AS (
            SELECT
              h.id_historique,
              h.id_outil,
              h.id_fournisseur,
              f.nom AS fournisseur_nom,
              h.date_prix::text AS date_prix,
              h.prix,
              NULL::int AS id_mouvement,
              NULL::int AS quantite,
              NULL::text AS source,
              NULL::text AS reason,
              NULL::text AS note,
              NULL::bigint AS affaire_id,
              'history'::text AS source_table
            FROM gestion_outils_historique_prix h
            LEFT JOIN gestion_outils_fournisseur f ON f.id_fournisseur = h.id_fournisseur
            WHERE h.id_outil = $1
              AND NOT EXISTS (
                SELECT 1
                FROM movement_events me
                WHERE me.id_fournisseur IS NOT DISTINCT FROM h.id_fournisseur
                  AND me.date_prix IS NOT DISTINCT FROM h.date_prix::text
                  AND me.prix IS NOT DISTINCT FROM h.prix
              )
          )
          SELECT *
          FROM movement_events
          UNION ALL
          SELECT *
          FROM history_only
          ORDER BY date_prix ASC NULLS LAST, id_mouvement ASC NULLS LAST, id_historique ASC NULLS LAST
        `,
        [id_outil]
      ),
      db.query(
        `
          WITH supplier_prices AS (
            SELECT m.id_fournisseur, m.prix_unitaire AS prix, m.date_mouvement AS event_date
            FROM gestion_outils_mouvement_stock m
            WHERE m.id_outil = $1
              AND m.type_mouvement = 'entrée'
              AND m.id_fournisseur IS NOT NULL
              AND m.prix_unitaire IS NOT NULL
            UNION ALL
            SELECT h.id_fournisseur, h.prix, h.date_prix
            FROM gestion_outils_historique_prix h
            WHERE h.id_outil = $1
              AND h.id_fournisseur IS NOT NULL
          ),
          ranked AS (
            SELECT
              sp.id_fournisseur,
              f.nom AS fournisseur_nom,
              sp.prix,
              sp.event_date,
              ROW_NUMBER() OVER (PARTITION BY sp.id_fournisseur ORDER BY sp.event_date DESC NULLS LAST) AS rn
            FROM supplier_prices sp
            JOIN gestion_outils_fournisseur f ON f.id_fournisseur = sp.id_fournisseur
          )
          SELECT
            ranked.id_fournisseur,
            ranked.fournisseur_nom,
            COUNT(*)::int AS transactions_count,
            MIN(ranked.prix) AS min_price,
            MAX(ranked.prix) AS max_price,
            ROUND(AVG(ranked.prix)::numeric, 2) AS avg_price,
            MAX(CASE WHEN ranked.rn = 1 THEN ranked.prix END) AS last_price,
            MAX(CASE WHEN ranked.rn = 1 THEN ranked.event_date::text END) AS last_price_date
          FROM ranked
          GROUP BY ranked.id_fournisseur, ranked.fournisseur_nom
          ORDER BY avg_price ASC NULLS LAST, ranked.fournisseur_nom ASC
        `,
        [id_outil]
      ),
      db.query(
        `
          SELECT
            m.id_mouvement,
            m.type_mouvement,
            m.quantite,
            m.date_mouvement::text AS date_mouvement,
            m.commentaire,
            m.utilisateur,
            m.user_id,
            m.reason,
            m.source,
            m.note,
            m.affaire_id,
            m.id_fournisseur,
            f.nom AS fournisseur_nom,
            m.prix_unitaire
          FROM gestion_outils_mouvement_stock m
          LEFT JOIN gestion_outils_fournisseur f ON f.id_fournisseur = m.id_fournisseur
          WHERE m.id_outil = $1
            AND m.type_mouvement = 'entrée'
            AND m.id_fournisseur IS NOT NULL
            AND m.prix_unitaire IS NOT NULL
          ORDER BY m.date_mouvement DESC NULLS LAST, m.id_mouvement DESC
        `,
        [id_outil]
      ),
    ]);

    return {
      history: historyRows.rows.map(mapPriceHistoryEntry),
      supplier_summary: summaryRows.rows.map(mapSupplierSummary),
      replenishments: replenishmentRows.rows.map(mapStockMovement),
    };
  },
};
