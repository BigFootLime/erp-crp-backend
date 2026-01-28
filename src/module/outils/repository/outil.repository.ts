// ✅ Début de migration pro du module "outil" vers architecture erp-crp-backend
// Fichier : /src/module/outils/repository/outil.repository.ts

import path from "path";
import db from "../../../config/database";

const BASE_IMAGE_URL =
  process.env.BACKEND_URL || "http://erp-backend.croix-rousse-precision.fr:8080";

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
};

export const outilRepository = {
  // 🔍 Trouver un outil par son ID
  async findById(id: number) {
    const result = await db.query("SELECT * FROM gestion_outils_outil WHERE id_outil = $1", [id]);
    return result.rows[0] || null;
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

    return result.rows.map((row: any) => ({
      ...row,
      image_path: row.image_path ? `${BASE_IMAGE_URL}/images/${path.basename(row.image_path)}` : null,
      image: row.image ? `${BASE_IMAGE_URL}/images/${path.basename(row.image)}` : null,
      esquisse: row.esquisse ? `${BASE_IMAGE_URL}/images/${path.basename(row.esquisse)}` : null,
      plan: row.plan ? `${BASE_IMAGE_URL}/images/${path.basename(row.plan)}` : null,
      quantite_stock: row.quantite_stock ?? 0,
      quantite_minimale: row.quantite_minimale ?? 0,
    }));
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

    return result.rows;
  },

  // ➕ Créer un nouvel outil + gérer les relations + init stock
  async create(data: any, client: any): Promise<number> {
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
        data.esquisse,
        data.plan,
        data.image,
      ]
    );

    const id_outil = result.rows[0].id_outil;
    console.log("🛠️ Outil créé avec l'ID:", id_outil);

    // ✅ Stock initial (UPSERT)
    await this.initStock(client, id_outil, data.quantite_stock ?? 0, data.quantite_minimale ?? 0);

    // 🔗 relations
    if (data.fournisseurs?.length) await this.linkFournisseurs(client, id_outil, data.fournisseurs);
    if (data.revetements?.length) await this.linkRevetements(client, id_outil, data.revetements);
    if (data.valeurs_aretes?.length) await this.linkValeursAretes(client, id_outil, data.valeurs_aretes);

    return id_outil;
  },

  // ➕ Initialiser stock (UPSERT recommandé)
  async initStock(client: any, id_outil: number, quantite: number, quantite_minimale: number = 0) {
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

    console.log("📦 Stock initial enregistré:", { id_outil, quantite: qte, quantite_minimale: qteMin });
  },

  // ➕ Ajouter au stock
  async addToStock(client: any, id_outil: number, quantite: number) {
    const qte = Number(quantite);
    if (!Number.isFinite(qte) || qte <= 0) throw new Error("Quantité invalide pour addToStock");

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
  async removeFromStock(client: any, id_outil: number, quantity: number) {
    const qte = Number(quantity);
    if (!Number.isFinite(qte) || qte <= 0) throw new Error("Quantité invalide pour removeFromStock");

    const res = await client.query(
      `SELECT quantite FROM gestion_outils_stock WHERE id_outil = $1 FOR UPDATE`,
      [id_outil]
    );

    if (res.rowCount === 0) throw new Error("Stock introuvable pour cet outil.");

    const currentStock = Number(res.rows[0].quantite);
    if (currentStock < qte) throw new Error(`Stock insuffisant pour l'outil ${id_outil}.`);

    await client.query(
      `UPDATE gestion_outils_stock SET quantite = quantite - $1, date_maj = NOW() WHERE id_outil = $2`,
      [qte, id_outil]
    );
  },

  // 🧾 Ajuster stock en valeur absolue (inventaire)
  async setStockAbsolute(client: any, id_outil: number, newQty: number) {
    const qty = Number(newQty);
    if (!Number.isFinite(qty) || qty < 0) throw new Error("newQty invalide (doit être >= 0)");

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
  async insertHistoriquePrix(client: any, id_outil: number, prix: number, id_fournisseur: number) {
    const p = Number(prix);
    if (!Number.isFinite(p) || p < 0) throw new Error("Prix invalide");

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
          (id_outil, quantite, type_mouvement, utilisateur, user_id, reason, source, note, affaire_id, date_mouvement)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
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
        ]
      );
    } catch (err: any) {
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
    const result = await db.query(`SELECT id_famille, nom_famille FROM gestion_outils_famille ORDER BY ordre NULLS LAST, nom_famille`);
    return result.rows.map((row: any) => ({ value: row.id_famille, label: row.nom_famille }));
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

    return result.rows.map((row: any) => ({
      value: row.id_geometrie,
      label: row.nom_geometrie,
      imagePath: row.image_path ? `${BASE_IMAGE_URL}/images/${path.basename(row.image_path)}` : null,
    }));
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

    return result.rows.map((row: any) => ({
      ...row,
      image_path: row.image_path ? `${BASE_IMAGE_URL}/images/${path.basename(row.image_path)}` : null,
      image: row.image ? `${BASE_IMAGE_URL}/images/${path.basename(row.image)}` : null,
      esquisse: row.esquisse ? `${BASE_IMAGE_URL}/images/${path.basename(row.esquisse)}` : null,
      plan: row.plan ? `${BASE_IMAGE_URL}/images/${path.basename(row.plan)}` : null,
      quantite_stock: row.quantite_stock ?? 0,
      quantite_minimale: row.quantite_minimale ?? 0,
    }));
  },
};
