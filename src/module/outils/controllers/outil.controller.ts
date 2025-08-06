import { Request, Response, NextFunction } from "express";
import { outilService, outilSupportService } from "../services/outil.service";
import { CreateOutilInput, outilSchema } from "../validators/outil.validator";
import { parseId } from "../../../utils/parseId";
import {parseString} from "../../../utils/parseString"
const BASE_IMAGE_URL = process.env.BACKEND_URL || "http://192.168.1.244:5000"
import { getIO } from '../../../sockets/sockeServer'; // ou depuis le bon chemin

export const outilController = {

    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
          const outils = await outilService.getAllOutils();
          res.status(200).json(outils);
        } catch (error) {
          next(error);
        }
      },
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const id = parseId(req.params.id, "ID Outil");
            const outil = await outilService.getOutil(id);
            res.status(200).json(outil);
        } catch (error) {
            next(error);
        }
    },

    async getByReferenceFabricant(req: Request, res: Response, next: NextFunction) {
        try {
            const ref = parseString(req.params.ref_fabricant, "Référence fabricant");
            const outil = await outilService.getOutilByRefFabricant(ref);
    
            if (!outil) return res.status(404).json({ message: "Aucun outil trouvé." });
    
            res.status(200).json(outil);
        } catch (error) {
            next(error);
        }
    },
    
      

    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { data } = req.body;
            if (!data) throw new Error("Données manquantes");

            const parsed = outilSchema.parse(JSON.parse(data)); // ✅ validation

            // 📂 Fichiers reçus
            const fichiers = req.files as {
                [fieldname: string]: Express.Multer.File[];
            };

            const cheminsImages = {
                esquisse: fichiers?.esquisse?.[0]
                    ? `\\\\192.168.1.245\\ERP\\CRP_SYSTEMS\\images\\${fichiers.esquisse[0].filename}`
                    : null,
                plan: fichiers?.plan?.[0]
                    ? `\\\\192.168.1.245\\ERP\\CRP_SYSTEMS\\images\\${fichiers.plan[0].filename}`
                    : null,
                image: fichiers?.image?.[0]
                    ? `\\\\192.168.1.245\\ERP\\CRP_SYSTEMS\\images\\${fichiers.image[0].filename}`
                    : null,
            };

            const finalData = {
                ...parsed,
                ...cheminsImages,
            };

            const result = await outilService.createOutil(finalData);
            res.status(201).json(result);
        } catch (error) {
            next(error);
        }
    },

    async sortieStock(req: Request, res: Response, next: NextFunction) {
        try {
          const { id, quantity } = req.body;
          const user = req.user?.username || "Utilisateur inconnu";
      
          if (!id || !quantity) {
            return res.status(400).json({ error: "Paramètres 'id' et 'quantity' requis." });
          }
      
          await outilService.sortieStock(Number(id), Number(quantity), user);
      
          // ✅ EMIT APRES SUCCÈS
          const io = getIO();
          io.emit("stockUpdated", {
            id_outil: id,
            quantity,
            user,
            type: "sortie",
            date: new Date().toISOString(),
          });
      
          return res.status(200).json({
            success: true,
            message: `🛠️ Outil ${id} retiré du stock par ${user}, quantité : ${quantity}`,
          });
        } catch (error) {
          next(error);
        }
      },

      reapprovisionner: async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { id_outil, quantite, prix, id_fournisseur } = req.body;
            const utilisateur = req.user?.username || "Utilisateur inconnu";

        if (!id_outil || !quantite || !prix || !id_fournisseur) {
            return res.status(400).json({ message: "Champs requis manquants." });
        }

        await outilService.reapprovisionner(
            Number(id_outil),
            Number(quantite),
            Number(prix),
            Number(id_fournisseur),
            utilisateur
      );

        const io = getIO();
             io.emit("stockUpdated", {
             id_outil,
             quantity: quantite,
             user: utilisateur,
             type: "reapprovisionnement",
             date: new Date().toISOString(),
     });

        return res.status(200).json({
        success: true,
        message: `✅ Outil ${id_outil} réapprovisionné de ${quantite} unités.`
        });
        } catch (error) {
            next(error);
        }
  },
};

export const outilSupportController = {
    getFamilles: async (_: Request, res: Response, next: NextFunction) => {
        try {
            const familles = await outilSupportService.getFamilles();
            res.json(familles);
        } catch (err) {
            next(err);
        }
    },

    getFabricants: async (_: Request, res: Response, next: NextFunction) => {
        try {
            const fabricants = await outilSupportService.getFabricants();
            res.json(fabricants);
        } catch (err) {
            next(err);
        }
    },

    postFabricant: async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { nom_fabricant, id_fournisseurs } = req.body;
            const parsedFournisseurs = JSON.parse(id_fournisseurs);

            const logo = req.file ? `\\\\192.168.1.245\\ERP\\CRP_SYSTEMS\\images\\${req.file.filename}` : null;

            const id = await outilSupportService.createFabricant(nom_fabricant, logo, parsedFournisseurs);
            res.status(201).json({ message: "Fabricant créé", id });
        } catch (err) {
            next(err);
        }
    },


    getFournisseurs: async (req: Request, res: Response, next: NextFunction) => {
        try {
            const fabricantId = req.query.fabricantId
                ? parseId(req.query.fabricantId as string, "ID Fabricant")
                : undefined;

            const fournisseurs = await outilSupportService.getFournisseurs(fabricantId);
            res.json(fournisseurs);
        } catch (err) {
            next(err);
        }
    },

    postFournisseur: async (req: Request, res: Response, next: NextFunction) => {
        try {
            await outilSupportService.createFournisseur(req.body);
            res.status(201).json({ message: "Fournisseur créé" });

            const io = getIO();
                io.emit("fournisseurAdded");
        } catch (err) {
            next(err);
        }
    },

    getGeometries: async (req: Request, res: Response, next: NextFunction) => {
        try {
            const id = req.query.id_famille
                ? parseId(req.query.id_famille as string, "ID Famille")
                : undefined;

            const result = await outilSupportService.getGeometries(id);
            res.json(result);
        } catch (err) {
            next(err);
        }
    },

    getRevetements: async (req: Request, res: Response, next: NextFunction) => {
        try {
            const id = req.query.id_fabricant
                ? parseId(req.query.id_fabricant as string, "ID Fabricant")
                : undefined;

            

            const result = await outilSupportService.getRevetements(id);
            res.json(result);
        } catch (err) {
            next(err);
        }
    },

    getAretes: async (req: Request, res: Response, next: NextFunction) => {
        try {
            const id = req.query.id_geometrie
                ? parseId(req.query.id_geometrie as string, "ID Géométrie")
                : undefined;

            const result = await outilSupportService.getAretes(id);
            res.json(result);
        } catch (err) {
            next(err);
        }
    },

    

    postRevetement: async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { nom, id_fabricant } = req.body;
      
          if (!nom || typeof nom !== "string") {
            throw new Error("Le nom du revêtement est requis");
          }
          if (!id_fabricant || isNaN(Number(id_fabricant))) {
            throw new Error("Un fabricant valide est requis");
          }

           // 🧠 NOTIFIER TOUS LES CLIENTS CONNECTÉS
    const io = getIO();
    io.emit("revetementAdded"); // 👈 broadcast
      
          const id = await outilSupportService.createRevetement(nom, Number(id_fabricant));
          res.status(201).json({ message: "Revêtement créé", id });
        } catch (err) {
          next(err);
        }
      },

      

      
      
      
      
};


