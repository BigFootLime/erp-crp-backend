"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const outil_controller_1 = require("../controllers/outil.controller");
const router = (0, express_1.Router)();
// 🔧 Routes support (familles, fabricants, etc.)
router.get("/familles", outil_controller_1.outilSupportController.getFamilles);
router.get("/fabricants", outil_controller_1.outilSupportController.getFabricants);
router.post("/fabricants", outil_controller_1.outilSupportController.postFabricant);
router.get("/fournisseurs", outil_controller_1.outilSupportController.getFournisseurs);
router.post("/fournisseurs", outil_controller_1.outilSupportController.postFournisseur);
router.get("/geometries", outil_controller_1.outilSupportController.getGeometries);
router.get("/revetements", outil_controller_1.outilSupportController.getRevetements);
router.get("/aretes", outil_controller_1.outilSupportController.getAretes);
// 📦 Routes outil principal
router.post("/", outil_controller_1.outilController.create);
router.get("/:id", outil_controller_1.outilController.getById); // ⚠️ Toujours à la fin !
exports.default = router;
