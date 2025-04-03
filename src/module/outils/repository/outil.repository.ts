// ✅ Début de migration pro du module "outil" vers architecture erp-crp-backend
// Fichier : /src/module/outils/repository/outil.repository.ts

import db from "../../../config/database";

export const outilRepository = {
    // 🔍 Trouver un outil par son ID
    async findById(id: number) {
        const result = await db.query(
            "SELECT * FROM gestion_outils_outil WHERE id_outil = $1",
            [id]
        );
        return result.rows[0] || null;
    },

    // ➕ Créer un nouvel outil (version simplifiée - version étendue via service)
    async create(data: any): Promise<number> {
        const result = await db.query(
            `INSERT INTO gestion_outils_outil (
        id_fabricant, id_famille, id_geometrie, reference_fabricant, designation, revetement, codification, usinage, 
        plan, angle_helico, type_coins, diametre_nominal, diametre_coupe, diametre_tige, profondeur_percage, 
        angle_pointe, type_concage, type_entree, type_fixation, matiere_usiner, type_arrosage
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      ) RETURNING id_outil`,
            [
                data.id_fabricant,
                data.id_famille,
                data.id_geometrie,
                data.reference_fabricant,
                data.designation,
                data.revetement,
                data.codification,
                data.usinage,
                data.plan,
                data.angle_helico,
                data.type_coins,
                data.diametre_nominal,
                data.diametre_coupe,
                data.diametre_tige,
                data.profondeur_percage,
                data.angle_pointe,
                data.type_concage,
                data.type_entree,
                data.type_fixation,
                data.matiere_usiner,
                data.type_arrosage
            ]
        );
        return result.rows[0].id_outil;
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
            email
        } = data;
        await db.query(
            `INSERT INTO gestion_outils_fournisseur 
        (nom, adresse_ligne, house_no, postcode, city, country, phone_num, email) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [nom, adresse_ligne, house_no, postcode, city, country, phone_num, email]
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
            imagePath: row.image_path ? `http://localhost:5000/images/${row.image_path}` : null,
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
    }
};
