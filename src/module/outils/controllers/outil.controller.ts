// src/module/outils/controllers/outil.controller.ts
import { Request, Response, NextFunction } from "express";
import { outilService, outilSupportService } from "../services/outil.service";
import { outilSchema } from "../validators/outil.validator";
import { parseId } from "../../../utils/parseId";
import { parseString } from "../../../utils/parseString";
import { getIO } from "../../../sockets/sockeServer";

// ⚠️ adapte ce chemin réseau si besoin
const IMAGE_SHARE_PATH = "\\\\192.168.1.245\\ERP\\CRP_SYSTEMS\\images\\";

function isPgUniqueViolation(err: any) {
  return err?.code === "23505";
}

function uniqueViolationDetails(err: any) {
  // pg: err.constraint / err.detail / err.table
  return {
    constraint: err?.constraint,
    detail: err?.detail,
    table: err?.table,
  };
}

export const outilController = {
  // ✅ Liste complète (legacy)
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const outils = await outilService.getAllOutils();
      return res.status(200).json(outils);
    } catch (error) {
      next(error);
    }
  },

  // ✅ Liste filtrée / paginée pour UI cards
  async getFiltered(req: Request, res: Response, next: NextFunction) {
    try {
      // query params: id_famille, id_geometrie, q, only_in_stock, limit, offset
      const id_famille = req.query.id_famille ? Number(req.query.id_famille) : undefined;
      const id_geometrie = req.query.id_geometrie ? Number(req.query.id_geometrie) : undefined;
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      const only_in_stock =
        typeof req.query.only_in_stock === "string"
          ? req.query.only_in_stock === "true" || req.query.only_in_stock === "1"
          : undefined;

      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;

      if (id_famille !== undefined && (!Number.isFinite(id_famille) || id_famille <= 0)) {
        return res.status(400).json({ message: "id_famille invalide" });
      }
      if (id_geometrie !== undefined && (!Number.isFinite(id_geometrie) || id_geometrie <= 0)) {
        return res.status(400).json({ message: "id_geometrie invalide" });
      }
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        return res.status(400).json({ message: "limit invalide" });
      }
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        return res.status(400).json({ message: "offset invalide" });
      }

      const outils = await outilService.getAllFiltered({
        id_famille,
        id_geometrie,
        q,
        only_in_stock,
        limit,
        offset,
      });

      return res.status(200).json(outils);
    } catch (error) {
      next(error);
    }
  },

  // 🚨 Outils sous le stock minimum
  async getLowStock(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await outilService.getLowStock();
      return res.status(200).json(rows);
    } catch (error) {
      next(error);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseId(req.params.id, "ID Outil");
      const outil = await outilService.getOutil(id);
      return res.status(200).json(outil);
    } catch (error) {
      next(error);
    }
  },

  async getByReferenceFabricant(req: Request, res: Response, next: NextFunction) {
    try {
      const ref = parseString(req.params.ref_fabricant, "Référence fabricant");
      const outil = await outilService.getOutilByRefFabricant(ref);

      if (!outil) return res.status(404).json({ message: "Aucun outil trouvé." });

      return res.status(200).json(outil);
    } catch (error) {
      next(error);
    }
  },

  // ✅ Création outil + images + relations + init stock (UPSERT via repo)
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { data } = req.body;
      if (!data) return res.status(400).json({ message: "Données manquantes (champ 'data')" });

      // ✅ validation Zod
      const parsed = outilSchema.parse(JSON.parse(data));

      // 📂 Fichiers reçus (multer fields)
      const fichiers = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      const cheminsImages = {
        esquisse: fichiers?.esquisse?.[0] ? `${IMAGE_SHARE_PATH}${fichiers.esquisse[0].filename}` : null,
        plan: fichiers?.plan?.[0] ? `${IMAGE_SHARE_PATH}${fichiers.plan[0].filename}` : null,
        image: fichiers?.image?.[0] ? `${IMAGE_SHARE_PATH}${fichiers.image[0].filename}` : null,
      };

      const finalData = {
        ...parsed,
        ...cheminsImages,
      };

      const result = await outilService.createOutil(finalData);

      // 🔔 broadcast (optionnel, utile si tu as une page outils live)
      try {
        const io = getIO();
        io.emit("outilCreated", { id_outil: result.id_outil });
      } catch (_) {}

      return res.status(201).json(result);
    } catch (error: any) {
      // ✅ si l’index unique (id_fabricant, reference_fabricant) est violé
      if (isPgUniqueViolation(error)) {
        const meta = uniqueViolationDetails(error);
        return res.status(409).json({
          message: "Doublon: cette référence fabricant existe déjà pour ce fabricant.",
          ...meta,
        });
      }
      next(error);
    }
  },

  // ➖ Sortie stock MANUELLE (par ID outil)
  async sortieStock(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, quantity, reason, note, affaire_id } = req.body;

      const user = req.user?.username || "Utilisateur inconnu";
      const user_id = req.user?.id ?? null;

      if (id === undefined || quantity === undefined) {
        return res.status(400).json({ error: "Paramètres 'id' et 'quantity' requis." });
      }

      const id_outil = Number(id);
      const qte = Number(quantity);

      if (!Number.isFinite(id_outil) || id_outil <= 0) {
        return res.status(400).json({ error: "Paramètre 'id' invalide." });
      }
      if (!Number.isFinite(qte) || qte <= 0) {
        return res.status(400).json({ error: "Paramètre 'quantity' invalide (doit être > 0)." });
      }

      await outilService.sortieStock({
        id_outil,
        quantite: qte,
        utilisateur: user,
        user_id,
        reason: reason ?? null,
        source: "manual",
        note: note ?? null,
        affaire_id: affaire_id ? Number(affaire_id) : null,
      });

      // ✅ EMIT APRES SUCCÈS
      const io = getIO();
      io.emit("stockUpdated", {
        id_outil,
        quantity: qte,
        user,
        type: "sortie",
        date: new Date().toISOString(),
      });

      return res.status(200).json({
        success: true,
        message: `🛠️ Outil ${id_outil} retiré du stock par ${user}, quantité : ${qte}`,
      });
    } catch (error) {
      next(error);
    }
  },

  // ➕ Réapprovisionnement MANUEL (par ID outil)
  async reapprovisionner(req: Request, res: Response, next: NextFunction) {
    try {
      const { id_outil, quantite, prix, id_fournisseur, reason, note, affaire_id } = req.body;

      const utilisateur = req.user?.username || "Utilisateur inconnu";
      const user_id = req.user?.id ?? null;

      if (!id_outil || !quantite || prix === undefined || !id_fournisseur) {
        return res.status(400).json({ message: "Champs requis manquants." });
      }

      const idOutil = Number(id_outil);
      const qte = Number(quantite);
      const p = Number(prix);
      const idF = Number(id_fournisseur);

      if (!Number.isFinite(idOutil) || idOutil <= 0) return res.status(400).json({ message: "id_outil invalide" });
      if (!Number.isFinite(qte) || qte <= 0) return res.status(400).json({ message: "quantite invalide (>0)" });
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ message: "prix invalide (>=0)" });
      if (!Number.isFinite(idF) || idF <= 0) return res.status(400).json({ message: "id_fournisseur invalide" });

      await outilService.reapprovisionner({
        id_outil: idOutil,
        quantite: qte,
        prix: p,
        id_fournisseur: idF,
        utilisateur,
        user_id,
        reason: reason ?? null,
        source: "manual",
        note: note ?? null,
        affaire_id: affaire_id ? Number(affaire_id) : null,
      });

      const io = getIO();
      io.emit("stockUpdated", {
        id_outil: idOutil,
        quantity: qte,
        user: utilisateur,
        type: "entrée",
        date: new Date().toISOString(),
      });

      return res.status(200).json({
        success: true,
        message: `✅ Outil ${idOutil} réapprovisionné de ${qte} unités.`,
      });
    } catch (error) {
      next(error);
    }
  },

  // 📷 Scan sortie (code barre = reference_fabricant)
  async scanSortie(req: Request, res: Response, next: NextFunction) {
    try {
      const { barcode, quantity, reason, note, affaire_id } = req.body;

      const utilisateur = req.user?.username || "Utilisateur inconnu";
      const user_id = req.user?.id ?? null;

      if (!barcode) return res.status(400).json({ message: "barcode requis" });

      const ref = parseString(String(barcode), "barcode");
      const qte = quantity === undefined ? 1 : Number(quantity);

      if (!Number.isFinite(qte) || qte <= 0) {
        return res.status(400).json({ message: "quantity invalide (>0)" });
      }

      const result = await outilService.scanSortie({
        reference_fabricant: ref,
        quantite: qte,
        utilisateur,
        user_id,
        reason: reason ?? null,
        source: "scan",
        note: note ?? null,
        affaire_id: affaire_id ? Number(affaire_id) : null,
      });

      const io = getIO();
      io.emit("stockUpdated", {
        id_outil: result.id_outil,
        quantity: qte,
        user: utilisateur,
        type: "sortie",
        date: new Date().toISOString(),
        source: "scan",
      });

      return res.status(200).json({
        success: true,
        ...result,
        message: `📷 Sortie stock OK (${ref}) x${qte}`,
      });
    } catch (error) {
      next(error);
    }
  },

  // 📷 Scan entrée (code barre = reference_fabricant)
  async scanEntree(req: Request, res: Response, next: NextFunction) {
    try {
      const { barcode, quantity, prix, id_fournisseur, reason, note, affaire_id } = req.body;

      const utilisateur = req.user?.username || "Utilisateur inconnu";
      const user_id = req.user?.id ?? null;

      if (!barcode) return res.status(400).json({ message: "barcode requis" });

      const ref = parseString(String(barcode), "barcode");
      const qte = quantity === undefined ? 1 : Number(quantity);

      if (!Number.isFinite(qte) || qte <= 0) {
        return res.status(400).json({ message: "quantity invalide (>0)" });
      }

      // prix / fournisseur optionnels en scan (selon ton process)
      const p = prix !== undefined ? Number(prix) : undefined;
      const idF = id_fournisseur !== undefined ? Number(id_fournisseur) : undefined;

      if (p !== undefined && (!Number.isFinite(p) || p < 0)) return res.status(400).json({ message: "prix invalide (>=0)" });
      if (idF !== undefined && (!Number.isFinite(idF) || idF <= 0)) return res.status(400).json({ message: "id_fournisseur invalide" });

      const result = await outilService.scanEntree({
        reference_fabricant: ref,
        quantite: qte,
        prix: p,
        id_fournisseur: idF,
        utilisateur,
        user_id,
        reason: reason ?? null,
        source: "scan",
        note: note ?? null,
        affaire_id: affaire_id ? Number(affaire_id) : null,
      });

      const io = getIO();
      io.emit("stockUpdated", {
        id_outil: result.id_outil,
        quantity: qte,
        user: utilisateur,
        type: "entrée",
        date: new Date().toISOString(),
        source: "scan",
      });

      return res.status(200).json({
        success: true,
        ...result,
        message: `📷 Entrée stock OK (${ref}) x${qte}`,
      });
    } catch (error) {
      next(error);
    }
  },

  // 🧾 Inventaire: set stock absolu
  async inventaireSet(req: Request, res: Response, next: NextFunction) {
    try {
      const { id_outil, new_qty, reason, note } = req.body;

      const utilisateur = req.user?.username || "Utilisateur inconnu";
      const user_id = req.user?.id ?? null;

      if (!id_outil || new_qty === undefined) {
        return res.status(400).json({ message: "id_outil et new_qty requis" });
      }

      const idOutil = Number(id_outil);
      const qty = Number(new_qty);

      if (!Number.isFinite(idOutil) || idOutil <= 0) return res.status(400).json({ message: "id_outil invalide" });
      if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ message: "new_qty invalide (>=0)" });

      await outilService.inventaireSet({
        id_outil: idOutil,
        new_qty: qty,
        utilisateur,
        user_id,
        reason: reason ?? "inventaire",
        source: "manual",
        note: note ?? null,
      });

      const io = getIO();
      io.emit("stockUpdated", {
        id_outil: idOutil,
        quantity: qty,
        user: utilisateur,
        type: "inventaire",
        date: new Date().toISOString(),
      });

      return res.status(200).json({ success: true, message: `📦 Inventaire OK (outil ${idOutil} => ${qty})` });
    } catch (error) {
      next(error);
    }
  },
};

export const outilSupportController = {
  getFamilles: async (_: Request, res: Response, next: NextFunction) => {
    try {
      const familles = await outilSupportService.getFamilles();
      return res.json(familles);
    } catch (err) {
      next(err);
    }
  },

  getFabricants: async (_: Request, res: Response, next: NextFunction) => {
    try {
      const fabricants = await outilSupportService.getFabricants();
      return res.json(fabricants);
    } catch (err) {
      next(err);
    }
  },

  postFabricant: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { nom_fabricant, id_fournisseurs } = req.body;

      if (!nom_fabricant) return res.status(400).json({ message: "nom_fabricant requis" });

      const parsedFournisseurs: number[] = id_fournisseurs ? JSON.parse(id_fournisseurs) : [];
      if (!Array.isArray(parsedFournisseurs)) return res.status(400).json({ message: "id_fournisseurs invalide" });

      const logo = req.file ? `${IMAGE_SHARE_PATH}${req.file.filename}` : null;

      const id = await outilSupportService.createFabricant(nom_fabricant, logo, parsedFournisseurs);
      return res.status(201).json({ message: "Fabricant créé", id });
    } catch (err) {
      next(err);
    }
  },

  getFournisseurs: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fabricantId = req.query.fabricantId ? parseId(req.query.fabricantId as string, "ID Fabricant") : undefined;
      const fournisseurs = await outilSupportService.getFournisseurs(fabricantId);
      return res.json(fournisseurs);
    } catch (err) {
      next(err);
    }
  },

  postFournisseur: async (req: Request, res: Response, next: NextFunction) => {
    try {
      await outilSupportService.createFournisseur(req.body);
      res.status(201).json({ message: "Fournisseur créé" });

      try {
        const io = getIO();
        io.emit("fournisseurAdded");
      } catch (_) {}
    } catch (err) {
      next(err);
    }
  },

  getGeometries: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.query.id_famille ? parseId(req.query.id_famille as string, "ID Famille") : undefined;
      const result = await outilSupportService.getGeometries(id);
      return res.json(result);
    } catch (err) {
      next(err);
    }
  },

  getRevetements: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.query.id_fabricant ? parseId(req.query.id_fabricant as string, "ID Fabricant") : undefined;
      const result = await outilSupportService.getRevetements(id);
      return res.json(result);
    } catch (err) {
      next(err);
    }
  },

  getAretes: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.query.id_geometrie ? parseId(req.query.id_geometrie as string, "ID Géométrie") : undefined;
      const result = await outilSupportService.getAretes(id);
      return res.json(result);
    } catch (err) {
      next(err);
    }
  },

  postRevetement: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { nom, id_fabricant } = req.body;

      if (!nom || typeof nom !== "string") {
        return res.status(400).json({ message: "Le nom du revêtement est requis" });
      }
      if (!id_fabricant || isNaN(Number(id_fabricant))) {
        return res.status(400).json({ message: "Un fabricant valide est requis" });
      }

      const id = await outilSupportService.createRevetement(nom, Number(id_fabricant));

      try {
        const io = getIO();
        io.emit("revetementAdded");
      } catch (_) {}

      return res.status(201).json({ message: "Revêtement créé", id });
    } catch (err) {
      next(err);
    }
  },
};
