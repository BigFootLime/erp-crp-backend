import { outilRepository } from "../repository/outil.repository";

export const outilService = {
    async getOutil(id: number) {
        const outil = await outilRepository.findById(id);
        if (!outil) throw new Error("Outil non trouvé");
        return outil;
    },

    async createOutil(data: any) {
        const id_outil = await outilRepository.create(data);
        return { id_outil };
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
};