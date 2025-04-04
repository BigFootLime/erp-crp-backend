"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outilSupportController = exports.outilController = void 0;
const outil_service_1 = require("../services/outil.service");
const outil_validator_1 = require("../validators/outil.validator");
const parseId_1 = require("../../../utils/parseId");
exports.outilController = {
    async getById(req, res, next) {
        try {
            const id = (0, parseId_1.parseId)(req.params.id, "ID Outil");
            const outil = await outil_service_1.outilService.getOutil(id);
            res.status(200).json(outil);
        }
        catch (error) {
            next(error);
        }
    },
    async create(req, res, next) {
        try {
            const validated = outil_validator_1.outilSchema.parse(req.body);
            const result = await outil_service_1.outilService.createOutil(validated);
            res.status(201).json(result);
        }
        catch (error) {
            next(error);
        }
    }
};
exports.outilSupportController = {
    getFamilles: async (_, res, next) => {
        try {
            const familles = await outil_service_1.outilSupportService.getFamilles();
            res.json(familles);
        }
        catch (err) {
            next(err);
        }
    },
    getFabricants: async (_, res, next) => {
        try {
            const fabricants = await outil_service_1.outilSupportService.getFabricants();
            res.json(fabricants);
        }
        catch (err) {
            next(err);
        }
    },
    postFabricant: async (req, res, next) => {
        try {
            const { nom_fabricant, id_fournisseurs, logo } = req.body;
            const id = await outil_service_1.outilSupportService.createFabricant(nom_fabricant, logo, id_fournisseurs);
            res.status(201).json({ message: "Fabricant créé", id });
        }
        catch (err) {
            next(err);
        }
    },
    getFournisseurs: async (req, res, next) => {
        try {
            const fabricantId = req.query.fabricantId
                ? (0, parseId_1.parseId)(req.query.fabricantId, "ID Fabricant")
                : undefined;
            const fournisseurs = await outil_service_1.outilSupportService.getFournisseurs(fabricantId);
            res.json(fournisseurs);
        }
        catch (err) {
            next(err);
        }
    },
    postFournisseur: async (req, res, next) => {
        try {
            await outil_service_1.outilSupportService.createFournisseur(req.body);
            res.status(201).json({ message: "Fournisseur créé" });
        }
        catch (err) {
            next(err);
        }
    },
    getGeometries: async (req, res, next) => {
        try {
            const id = req.query.id_famille
                ? (0, parseId_1.parseId)(req.query.id_famille, "ID Famille")
                : undefined;
            const result = await outil_service_1.outilSupportService.getGeometries(id);
            res.json(result);
        }
        catch (err) {
            next(err);
        }
    },
    getRevetements: async (req, res, next) => {
        try {
            const id = req.query.id_fabricant
                ? (0, parseId_1.parseId)(req.query.id_fabricant, "ID Fabricant")
                : undefined;
            const result = await outil_service_1.outilSupportService.getRevetements(id);
            res.json(result);
        }
        catch (err) {
            next(err);
        }
    },
    getAretes: async (req, res, next) => {
        try {
            const id = req.query.id_geometrie
                ? (0, parseId_1.parseId)(req.query.id_geometrie, "ID Géométrie")
                : undefined;
            const result = await outil_service_1.outilSupportService.getAretes(id);
            res.json(result);
        }
        catch (err) {
            next(err);
        }
    }
};
