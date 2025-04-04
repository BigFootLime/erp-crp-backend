import { Request, Response, NextFunction } from "express";
import { outilService, outilSupportService } from "../services/outil.service";
import { CreateOutilInput, outilSchema } from "../validators/outil.validator";
import { parseId } from "../../../utils/parseId";

export const outilController = {
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const id = parseId(req.params.id, "ID Outil");
            const outil = await outilService.getOutil(id);
            res.status(200).json(outil);
        } catch (error) {
            next(error);
        }
    },

    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const validated = outilSchema.parse(req.body);
            const result = await outilService.createOutil(validated);
            res.status(201).json(result);
        } catch (error) {
            next(error);
        }
    }
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
            const { nom_fabricant, id_fournisseurs, logo } = req.body;
            const id = await outilSupportService.createFabricant(nom_fabricant, logo, id_fournisseurs);
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
    }
};
