"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outilSupportService = exports.outilService = void 0;
const outil_repository_1 = require("../repository/outil.repository");
exports.outilService = {
    async getOutil(id) {
        const outil = await outil_repository_1.outilRepository.findById(id);
        if (!outil)
            throw new Error("Outil non trouvé");
        return outil;
    },
    async createOutil(data) {
        const id_outil = await outil_repository_1.outilRepository.create(data);
        return { id_outil };
    },
};
exports.outilSupportService = {
    getFamilles: () => outil_repository_1.outilRepository.getFamilles(),
    getFabricants: () => outil_repository_1.outilRepository.getFabricants(),
    getFournisseurs: (fabricantId) => outil_repository_1.outilRepository.getFournisseurs(fabricantId),
    createFabricant: (nom, logo, fournisseurs) => outil_repository_1.outilRepository.createFabricant(nom, logo, fournisseurs),
    createFournisseur: (data) => outil_repository_1.outilRepository.createFournisseur(data),
    getGeometries: (id_famille) => outil_repository_1.outilRepository.getGeometries(id_famille),
    getRevetements: (id_fabricant) => outil_repository_1.outilRepository.getRevetements(id_fabricant),
    getAretes: (id_geometrie) => outil_repository_1.outilRepository.getAretes(id_geometrie),
};
