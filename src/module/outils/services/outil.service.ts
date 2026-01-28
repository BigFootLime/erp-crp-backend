// src/module/outils/services/outil.service.ts
import db from "../../../config/database";
import { outilRepository } from "../repository/outil.repository";
import { CreateOutilInput } from "../validators/outil.validator";

type SortieStockPayload = {
  id_outil: number;
  quantite: number;
  utilisateur: string;

  // enrichis (migration BDD)
  user_id?: number | null;
  reason?: string | null;
  source?: string | null; // 'scan' | 'manual'
  note?: string | null;
  affaire_id?: number | null;
};

type ReapproPayload = {
  id_outil: number;
  quantite: number;
  prix: number;
  id_fournisseur: number;
  utilisateur: string;

  // enrichis
  user_id?: number | null;
  reason?: string | null;
  source?: string | null; // 'scan' | 'manual'
  note?: string | null;
  affaire_id?: number | null;
};

type ScanSortiePayload = {
  reference_fabricant: string;
  quantite: number;
  utilisateur: string;

  // enrichis
  user_id?: number | null;
  reason?: string | null;
  source?: string | null; // 'scan'
  note?: string | null;
  affaire_id?: number | null;
};

type ScanEntreePayload = {
  reference_fabricant: string;
  quantite: number;
  utilisateur: string;

  // optionnels (selon ton process scan)
  prix?: number;
  id_fournisseur?: number;

  // enrichis
  user_id?: number | null;
  reason?: string | null;
  source?: string | null; // 'scan'
  note?: string | null;
  affaire_id?: number | null;
};

type InventaireSetPayload = {
  id_outil: number;
  new_qty: number;
  utilisateur: string;

  // enrichis
  user_id?: number | null;
  reason?: string | null; // 'inventaire'
  source?: string | null; // 'manual'
  note?: string | null;
};

function assertPositiveInt(n: number, label: string) {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} invalide`);
}

function assertPositiveNumber(n: number, label: string) {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} invalide (doit être > 0)`);
}

function assertNonNegativeNumber(n: number, label: string) {
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} invalide (doit être >= 0)`);
}

export const outilService = {
  // ✅ Liste complète (legacy)
  async getAllOutils() {
    return outilRepository.findAll();
  },

  // ✅ Liste filtrée/paginée (UI)
  async getAllFiltered(filters: {
    id_famille?: number;
    id_geometrie?: number;
    q?: string;
    only_in_stock?: boolean;
    limit?: number;
    offset?: number;
  }) {
    return outilRepository.findAllFiltered(filters);
  },

  // 🚨 Stock bas
  async getLowStock() {
    return outilRepository.getLowStock();
  },

  async getOutil(id: number) {
    assertPositiveInt(id, "ID outil");
    const outil = await outilRepository.findById(id);
    if (!outil) throw new Error("Outil non trouvé");
    return outil;
  },

  async getOutilByRefFabricant(reference_fabricant: string) {
    if (!reference_fabricant || typeof reference_fabricant !== "string") {
      throw new Error("Référence fabricant invalide");
    }
    return outilRepository.findByReferenceFabricant(reference_fabricant);
  },

  // ✅ Création outil (le repository gère déjà initStock + relations)
  async createOutil(data: CreateOutilInput) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const id_outil = await outilRepository.create(data, client);

      await client.query("COMMIT");
      return { id_outil };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  // ➖ Sortie stock (par ID)
  async sortieStock(payload: SortieStockPayload) {
    const { id_outil, quantite, utilisateur } = payload;

    assertPositiveInt(id_outil, "id_outil");
    assertPositiveNumber(quantite, "quantite");
    if (!utilisateur) throw new Error("utilisateur requis");

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await outilRepository.removeFromStock(client, id_outil, quantite);

      await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "sortie",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? null,
        source: payload.source ?? "manual",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      });

      await client.query("COMMIT");
      return { success: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  // ➕ Réapprovisionnement (par ID)
  async reapprovisionner(payload: ReapproPayload) {
    const { id_outil, quantite, prix, id_fournisseur, utilisateur } = payload;

    assertPositiveInt(id_outil, "id_outil");
    assertPositiveNumber(quantite, "quantite");
    assertNonNegativeNumber(prix, "prix");
    assertPositiveInt(id_fournisseur, "id_fournisseur");
    if (!utilisateur) throw new Error("utilisateur requis");

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await outilRepository.addToStock(client, id_outil, quantite);

      // historiser prix si tu l’exiges à chaque entrée
      await outilRepository.insertHistoriquePrix(client, id_outil, prix, id_fournisseur);

      await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "entrée",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "réappro",
        source: payload.source ?? "manual",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      });

      await client.query("COMMIT");
      return { success: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  // 📷 Scan sortie (barcode = reference_fabricant)
  async scanSortie(payload: ScanSortiePayload) {
    const { reference_fabricant, quantite, utilisateur } = payload;

    if (!reference_fabricant) throw new Error("reference_fabricant requis");
    assertPositiveNumber(quantite, "quantite");
    if (!utilisateur) throw new Error("utilisateur requis");

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const outil = await outilRepository.findByReferenceFabricant(reference_fabricant, client);
      if (!outil) {
        throw new Error(`Aucun outil pour la référence fabricant: ${reference_fabricant}`);
      }

      const id_outil = Number(outil.id_outil);
      await outilRepository.removeFromStock(client, id_outil, quantite);

      await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "sortie",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "scan",
        source: payload.source ?? "scan",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      });

      await client.query("COMMIT");
      return { id_outil, reference_fabricant, quantite };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  // 📷 Scan entrée (barcode = reference_fabricant)
  async scanEntree(payload: ScanEntreePayload) {
    const { reference_fabricant, quantite, utilisateur } = payload;

    if (!reference_fabricant) throw new Error("reference_fabricant requis");
    assertPositiveNumber(quantite, "quantite");
    if (!utilisateur) throw new Error("utilisateur requis");

    if (payload.prix !== undefined) assertNonNegativeNumber(Number(payload.prix), "prix");
    if (payload.id_fournisseur !== undefined) assertPositiveInt(Number(payload.id_fournisseur), "id_fournisseur");

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const outil = await outilRepository.findByReferenceFabricant(reference_fabricant, client);
      if (!outil) {
        throw new Error(`Aucun outil pour la référence fabricant: ${reference_fabricant}`);
      }

      const id_outil = Number(outil.id_outil);
      await outilRepository.addToStock(client, id_outil, quantite);

      // si prix + fournisseur fournis -> historiser
      if (payload.prix !== undefined && payload.id_fournisseur !== undefined) {
        await outilRepository.insertHistoriquePrix(
          client,
          id_outil,
          Number(payload.prix),
          Number(payload.id_fournisseur)
        );
      }

      await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "entrée",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "scan",
        source: payload.source ?? "scan",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      });

      await client.query("COMMIT");
      return { id_outil, reference_fabricant, quantite };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  // 🧾 Inventaire => set stock absolu
  async inventaireSet(payload: InventaireSetPayload) {
    const { id_outil, new_qty, utilisateur } = payload;

    assertPositiveInt(id_outil, "id_outil");
    assertNonNegativeNumber(new_qty, "new_qty");
    if (!utilisateur) throw new Error("utilisateur requis");

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await outilRepository.setStockAbsolute(client, id_outil, new_qty);

      // log mouvement inventaire : on stocke la valeur absolue dans quantite (simple)
      await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite: Number(new_qty),
        type: "inventaire",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "inventaire",
        source: payload.source ?? "manual",
        note: payload.note ?? null,
        affaire_id: null,
      });

      await client.query("COMMIT");
      return { success: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

export const outilSupportService = {
  getFamilles: () => outilRepository.getFamilles(),
  getFabricants: () => outilRepository.getFabricants(),
  getFournisseurs: (fabricantId?: number) => outilRepository.getFournisseurs(fabricantId),

  createFabricant: (nom: string, logo: string | null, fournisseurs: number[]) =>
    outilRepository.createFabricant(nom, logo, fournisseurs),

  createFournisseur: (data: any) => outilRepository.createFournisseur(data),

  getGeometries: (id_famille?: number) => outilRepository.getGeometries(id_famille),
  getRevetements: (id_fabricant?: number) => outilRepository.getRevetements(id_fabricant),
  getAretes: (id_geometrie?: number) => outilRepository.getAretes(id_geometrie),

  createRevetement: (nom: string, id_fabricant: number) => outilRepository.createRevetement(nom, id_fabricant),
};
