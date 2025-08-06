// ✅ Début de migration pro du module "outil" vers architecture erp-crp-backend
// Fichier : /src/module/outils/repository/outil.repository.ts

import path from "path";

import db from "../../../config/database";
const BASE_IMAGE_URL = process.env.BACKEND_URL || "http://erp-backend.croix-rousse-precision.fr:8080";

export const outilRepository = {
    // 🔍 Trouver un outil par son ID
    async findById(id: number) {
        const result = await db.query(
            "SELECT * FROM gestion_outils_outil WHERE id_outil = $1",
            [id]
        );
        return result.rows[0] || null;
    },

    // ➕ Créer un nouvel outil + gérer les relations
    async create(data: any, client: any): Promise<number> {
        
        

            const result = await client.query(
                `INSERT INTO gestion_outils_outil (
        id_fabricant, id_famille, id_geometrie, reference_fabricant, designation_outil_cnc, codification, matiere_usiner, 
        profondeur_utile, utilisation, longueur_coupe, longueur_detalonnee, longueur_totale, diametre_nominal, 
        diametre_queue, diametre_trou, diametre_detalonnee, angle_helice, angle_pointe, angle_filetage, 
        norme_filetage, pas_filetage, type_arrosage, type_entree, nombre_dents, esquisse, plan, image
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 
        $8, $9, $10, $11, $12, $13, 
        $14, $15, $16, $17, $18, $19, 
        $20, $21, $22, $23, $24, $25, $26, $27
    ) RETURNING id_outil`,
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

            
            await this.initStock(client, id_outil, data.quantite_stock, data.quantite_minimale);

  
            if (data.fournisseurs?.length) {
                await this.linkFournisseurs(client, id_outil, data.fournisseurs);
            }

            if (data.revetements?.length) {
                await this.linkRevetements(client, id_outil, data.revetements);
            }

            if (data.valeurs_aretes?.length) {
                await this.linkValeursAretes(client, id_outil, data.valeurs_aretes);
            }

         

           
            return id_outil;
      
    },

    // ➕ Initialiser le stock d’un outil
async initStock(client: any, id_outil: number, quantite: number, quantite_minimale: number = 0) {
    console.log("→ initStock appelé avec :", { quantite, quantite_minimale });
    if (quantite > 0 || quantite_minimale > 0) {
        await client.query(
            `INSERT INTO gestion_outils_stock (id_outil, quantite, quantite_minimale, date_maj)
             VALUES ($1, $2, $3, NOW())`,
            [id_outil, quantite, quantite_minimale]
        );
        console.log("📦 Stock initial enregistré:", { quantite, quantite_minimale });
    }
},
async addToStock(client: any, id_outil: number, quantite: number) {
  await client.query(
    `UPDATE gestion_outils_stock SET quantite = quantite + $1, date_maj = NOW() WHERE id_outil = $2`,
    [quantite, id_outil]
  );
},

async insertHistoriquePrix(client: any, id_outil: number, prix: number, id_fournisseur: number) {
  await client.query(
    `INSERT INTO gestion_outils_historique_prix (id_outil, prix, date_prix, id_fournisseur)
     VALUES ($1, $2, NOW(), $3)`,
    [id_outil, prix, id_fournisseur]
  );
},

async logMouvementStock(client: any, id_outil: number, quantite: number, type: string, utilisateur: string) {
  await client.query(
    `INSERT INTO gestion_outils_mouvement_stock (id_outil, quantite, type_mouvement, utilisateur, date_mouvement)
     VALUES ($1, $2, $3, $4, NOW())`,
    [id_outil, quantite, type, utilisateur]
  );
},

// ✅ Déduire une quantité du stock
async removeFromStock(id_outil: number, quantity: number, user: string, client?: any) {
    const dbClient = client || await db.connect();
    let releaseClient = false;

    try {
        if (!client) {
            releaseClient = true;
            await dbClient.query("BEGIN");
        }

        // Vérifie le stock actuel
        const res = await dbClient.query(
            `SELECT quantite FROM gestion_outils_stock WHERE id_outil = $1 FOR UPDATE`,
            [id_outil]
        );

        if (res.rowCount === 0) throw new Error("Stock introuvable pour cet outil.");
        const currentStock = res.rows[0].quantite;

        if (currentStock < quantity) {
            throw new Error(`Stock insuffisant pour l'outil ${id_outil}.`);
        }

        // Déduction du stock
        await dbClient.query(
            `UPDATE gestion_outils_stock SET quantite = quantite - $1, date_maj = NOW() WHERE id_outil = $2`,
            [quantity, id_outil]
        );

        // (Optionnel) journalisation
        await dbClient.query(
            `INSERT INTO gestion_outils_mouvement_stock (id_outil, quantite, type_mouvement, utilisateur, date_mouvement)
             VALUES ($1, $2, 'sortie', $3, NOW())`,
            [id_outil, quantity, user]
        );

        if (releaseClient) {
            await dbClient.query("COMMIT");
        }

        return true;
    } catch (err) {
        if (releaseClient) {
            await dbClient.query("ROLLBACK");
        }
        throw err;
    } finally {
        if (releaseClient) dbClient.release();
    }

    
},

async findByReferenceFabricant(reference_fabricant: string, client?: any): Promise<any> {
    const dbClient = client || await db.connect();
    let releaseClient = false;

    try {
        if (!client) releaseClient = true;
    const query = `
        SELECT 
    o.*,

    -- Fournisseurs liés à l'outil
    ARRAY(
        SELECT id_fournisseur
        FROM gestion_outils_outil_fournisseur
        WHERE id_outil = o.id_outil
    ) AS fournisseurs,

    -- Revêtements liés à l'outil
    ARRAY(
        SELECT id_revetement
        FROM gestion_outils_outil_revetement
        WHERE id_outil = o.id_outil
    ) AS revetements,

    -- Arêtes liées à l'outil (uniquement les ID)
    ARRAY(
        SELECT id_arete_coupe
        FROM gestion_outils_valeur_arete_coupe
        WHERE id_outil = o.id_outil
    ) AS aretes,

    -- Arêtes avec leurs valeurs sous forme JSON
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
LIMIT 1;

    `;

    const result = await dbClient.query(query, [reference_fabricant]);
        return result.rows[0] || null;
    } finally {
        if (releaseClient) dbClient.release();
    }
},

  

    // ➕ Lier un outil à ses fournisseurs (table relationnelle)
    async linkFournisseurs(client: any, id_outil: number, fournisseurs: number[]) {
        const queries = fournisseurs.map(fid =>
            client.query(
                `INSERT INTO gestion_outils_outil_fournisseur (id_outil, id_fournisseur) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [id_outil, fid]
            )
        );
        await Promise.all(queries);
        console.log("🧩 Fournisseurs liés:", fournisseurs);
    },

    // ➕ Lier un outil à ses revêtements (table relationnelle)
    async linkRevetements(client: any, id_outil: number, revetements: number[]) {
        const queries = revetements.map(rid =>
            client.query(
                `INSERT INTO gestion_outils_outil_revetement (id_outil, id_revetement) VALUES ($1, $2)`,
                [id_outil, rid]
            )
        );
        await Promise.all(queries);
        console.log("🎨 Revêtements liés:", revetements);
    },

    // ➕ Lier un outil à ses valeurs d’arêtes (table relationnelle)
    async linkValeursAretes(client: any, id_outil: number, valeurs: { id_arete_coupe: number, valeur: number }[]) {
        const queries = valeurs.map(({ id_arete_coupe, valeur }) =>
            client.query(
                `INSERT INTO gestion_outils_valeur_arete_coupe (id_outil, id_arete_coupe, valeur) VALUES ($1, $2, $3)`,
                [id_outil, id_arete_coupe, valeur]
            )
        );
        await Promise.all(queries);
        console.log("🪓 Valeurs arêtes liées:", valeurs);
    },

    // 📦 Familles outils
    async getFamilles() {
        const result = await db.query(
            "SELECT id_famille, nom_famille FROM gestion_outils_famille"
        );
        return result.rows.map(row => ({ value: row.id_famille, label: row.nom_famille }));
    },

    // 🏭 Fabricants
    async getFabricants() {
        const result = await db.query(
            "SELECT id_fabricant, name FROM gestion_outils_fabricant"
        );
        return result.rows.map(row => ({ value: row.id_fabricant, label: row.name }));
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
                `SELECT f.id_fournisseur, f.nom
         FROM gestion_outils_fournisseur f
         INNER JOIN gestion_outils_fournisseur_fabricant ff ON f.id_fournisseur = ff.id_fournisseur
         WHERE ff.id_fabricant = $1`,
                [fabricantId]
            );
            return result.rows.map(row => ({ value: row.id_fournisseur, label: row.nom }));
        } else {
            const result = await db.query(
                "SELECT id_fournisseur, nom FROM gestion_outils_fournisseur"
            );
            return result.rows.map(row => ({ value: row.id_fournisseur, label: row.nom }));
        }
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
            nom_commercial
        } = data;
        await db.query(
            `INSERT INTO gestion_outils_fournisseur 
        (nom, adresse_ligne, house_no, postcode, city, country, phone_num, email, nom_commercial) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [nom, adresse_ligne, house_no, postcode, city, country, phone_num, email, nom_commercial]
        );
    },

    async getGeometries(id_famille?: number) {
        let query = "SELECT * FROM gestion_outils_geometrie";
        let values: any[] = [];

        if (id_famille) {
            query += " WHERE id_famille = $1";
            values.push(id_famille);
        }

        const result = await db.query(query, values);

        return result.rows.map(row => ({
            value: row.id_geometrie,
            label: row.nom_geometrie,
            imagePath: row.image_path
                ? `${BASE_IMAGE_URL}/images/${path.basename(row.image_path)}`
                : null,
        }));
    },

    async getRevetements(id_fabricant?: number) {
        let query = "SELECT id_revetement, nom FROM gestion_outils_revetement";
        const params: any[] = [];
        if (id_fabricant) {
            query += " WHERE id_fabricant = $1";
            params.push(id_fabricant);
        }
        const result = await db.query(query, params);
        return result.rows.map(row => ({ value: row.id_revetement, label: row.nom }));
    },

    async getAretes(id_geometrie?: number) {
        let result;
        if (id_geometrie) {
            result = await db.query(
                `SELECT gac.id_arete_coupe, ac.nom_arete_coupe
         FROM gestion_outils_geometrie_aretecoupe gac
         JOIN gestion_outils_arete_coupe ac ON gac.id_arete_coupe = ac.id_arete_coupe
         WHERE gac.id_geometrie = $1
         ORDER BY ac.nom_arete_coupe`,
                [id_geometrie]
            );
        } else {
            result = await db.query(
                `SELECT id_arete_coupe, nom_arete_coupe FROM gestion_outils_arete_coupe ORDER BY nom_arete_coupe`
            );
        }
        return result.rows.map(row => ({ value: row.id_arete_coupe.toString(), label: row.nom_arete_coupe }));
    },

    async createRevetement(nom: string, id_fabricant: number) {
        const result = await db.query(
          `INSERT INTO gestion_outils_revetement (nom, id_fabricant)
           VALUES ($1, $2) RETURNING id_revetement`,
          [nom, id_fabricant]
        );
        return result.rows[0].id_revetement;
      },

      async findAll() {
        const result = await db.query(`
            SELECT
              o.*,
              f.name AS nom_fabricant,
              fam.nom_famille,
              g.nom_geometrie,
              g.image_path,
              s.quantite AS quantite_stock,
              s.quantite_minimale
            FROM gestion_outils_outil o
            LEFT JOIN gestion_outils_fabricant f ON o.id_fabricant = f.id_fabricant
            LEFT JOIN gestion_outils_famille fam ON o.id_famille = fam.id_famille
            LEFT JOIN gestion_outils_geometrie g ON o.id_geometrie = g.id_geometrie
            LEFT JOIN gestion_outils_stock s ON o.id_outil = s.id_outil
            ORDER BY o.id_outil DESC
          `);
          
          return result.rows.map(row => ({
            ...row,
            image_path: row.image_path
              ? `${BASE_IMAGE_URL}/images/${path.basename(row.image_path)}`
              : null,
            image: row.image
              ? `${BASE_IMAGE_URL}/images/${path.basename(row.image)}`
              : null,
            esquisse: row.esquisse
              ? `${BASE_IMAGE_URL}/images/${path.basename(row.esquisse)}`
              : null,
            plan: row.plan
              ? `${BASE_IMAGE_URL}/images/${path.basename(row.plan)}`
              : null,
            quantite_stock: row.quantite_stock ?? 0, // ← ici on sécurise avec 0 par défaut
            quantite_minimale: row.quantite_minimale ?? 0
          }));
          
      },
      
};