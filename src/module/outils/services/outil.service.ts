import { outilRepository } from "../repository/outil.repository";
import { CreateOutilInput } from "../validators/outil.validator";
import db from "../../../config/database";


export const outilService = {


    async reapprovisionner(id_outil: number, quantite: number, prix: number, id_fournisseur: number, utilisateur: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await outilRepository.addToStock(client, id_outil, quantite);
    await outilRepository.insertHistoriquePrix(client, id_outil, prix, id_fournisseur);
    await outilRepository.logMouvementStock(client, id_outil, quantite, "entrée", utilisateur);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
},

    async getAllOutils() {
        return outilRepository.findAll();
      },
      
    async getOutil(id: number) {
        const outil = await outilRepository.findById(id);
        if (!outil) throw new Error("Outil non trouvé");
        return outil;
    },

    async getOutilByRefFabricant(reference_fabricant: string) {
        return await outilRepository.findByReferenceFabricant(reference_fabricant);
    },
    
      

   

    async sortieStock(id: number, quantity: number, utilisateur: string) {
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          await outilRepository.removeFromStock(id, quantity, utilisateur, client);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },

    

    async createOutil(data: CreateOutilInput) {
        // Connexion à la base et début d'une transaction SQL
        const client = await db.connect();

        try {
            await client.query("BEGIN");

            // 🛠️ Crée l’outil principal et récupère son ID
            const id_outil = await outilRepository.create(data, client);

            // 🔗 Lier les fournisseurs si présents
            if (data.fournisseurs && data.fournisseurs.length > 0) {
                await outilRepository.linkFournisseurs(client, id_outil, data.fournisseurs);
            }

            // 🎨 Lier les revêtements si présents
            if (data.revetements && data.revetements.length > 0) {
                await outilRepository.linkRevetements(client, id_outil, data.revetements);
            }

            // 🦷 Lier les valeurs des arêtes si présentes
            if (data.valeurs_aretes && data.valeurs_aretes.length > 0) {
                await outilRepository.linkValeursAretes(client, id_outil, data.valeurs_aretes);
            }

            await client.query("COMMIT"); // Valide les modifications
            return { id_outil };

        } catch (error) {
            await client.query("ROLLBACK"); // Annule tout en cas d'erreur
            throw error;
        } finally {
            client.release(); // Libère la connexion
        }
    },
};

export const outilSupportService = {
    getFamilles: () => outilRepository.getFamilles(),
    getFabricants: () => outilRepository.getFabricants(),
    getFournisseurs: (fabricantId?: number) => outilRepository.getFournisseurs(fabricantId),
    createFabricant: (nom: string, logo: string | null, fournisseurs: number[]) => outilRepository.createFabricant(nom, logo, fournisseurs),
    createFournisseur: (data: any) => outilRepository.createFournisseur(data),
    getGeometries: (id_famille?: number) => outilRepository.getGeometries(id_famille),
    getRevetements: (id_fabricant?: number) => outilRepository.getRevetements(id_fabricant),
    getAretes: (id_geometrie?: number) => outilRepository.getAretes(id_geometrie),
    createRevetement: (nom: string, id_fabricant: number) =>
        outilRepository.createRevetement(nom, id_fabricant),
};
