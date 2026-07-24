import { Router } from "express"
import multer from "multer"

import { authenticateToken, authorizeRole } from "../../auth/middlewares/auth.middleware"
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage"
import {
  archiveFournisseur,
  attachFournisseurDocuments,
  createFournisseur,
  createFournisseurAdresse,
  createFournisseurCatalogueItem,
  createFournisseurContact,
  createFournisseurHomologation,
  deactivateFournisseur,
  deleteFournisseurAdresse,
  deleteFournisseurCatalogueItem,
  deleteFournisseurContact,
  downloadFournisseurDocument,
  findDoublons,
  getFournisseur,
  listFournisseurAdresses,
  listFournisseurCatalogue,
  listFournisseurContacts,
  listFournisseurDocuments,
  listFournisseurDomaines,
  listFournisseurEvents,
  listFournisseurHomologations,
  listFournisseurs,
  removeFournisseurDocument,
  replaceFournisseurDomaines,
  updateFournisseurAdresse,
  updateFournisseurCatalogueItem,
  updateFournisseurContact,
  updateFournisseurHomologation,
  updateFournisseur,
} from "../controllers/fournisseurs.controller"

// RBAC capability tiers (validated with the business). Reads are open to any
// authenticated internal user; writes and sensitive actions are role-gated.
const WRITE: string[] = ["Directeur", "Administrateur Systeme et Reseau", "Secretaire", "Responsable Programmation", "Responsable Qualité"]
const QUALIF: string[] = ["Directeur", "Administrateur Systeme et Reseau", "Responsable Qualité"]
const ARCHIVE: string[] = ["Directeur", "Administrateur Systeme et Reseau"]

const docsBaseDir = ensureDocumentStoragePath("fournisseurs")
const upload = multer({
  dest: docsBaseDir,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
})

const router = Router()
router.use(authenticateToken)

// Reads (any authenticated internal user). Static segments before "/:id".
router.get("/", listFournisseurs)
router.get("/doublons", authorizeRole(...WRITE), findDoublons)
router.get("/domaines", listFournisseurDomaines)
router.get("/:id", getFournisseur)
router.get("/:id/events", listFournisseurEvents)

// Master writes.
router.post("/", authorizeRole(...WRITE), createFournisseur)
router.patch("/:id", authorizeRole(...WRITE), updateFournisseur)
router.post("/:id/deactivate", authorizeRole(...QUALIF), deactivateFournisseur)
router.post("/:id/archive", authorizeRole(...ARCHIVE), archiveFournisseur)
router.put("/:id/domaines", authorizeRole(...WRITE), replaceFournisseurDomaines)

// Contacts.
router.get("/:id/contacts", listFournisseurContacts)
router.post("/:id/contacts", authorizeRole(...WRITE), createFournisseurContact)
router.patch("/:id/contacts/:contactId", authorizeRole(...WRITE), updateFournisseurContact)
router.delete("/:id/contacts/:contactId", authorizeRole(...WRITE), deleteFournisseurContact)

// Typed addresses.
router.get("/:id/adresses", listFournisseurAdresses)
router.post("/:id/adresses", authorizeRole(...WRITE), createFournisseurAdresse)
router.patch("/:id/adresses/:adresseId", authorizeRole(...WRITE), updateFournisseurAdresse)
router.delete("/:id/adresses/:adresseId", authorizeRole(...WRITE), deleteFournisseurAdresse)

// Homologations / qualification (quality tier).
router.get("/:id/homologations", listFournisseurHomologations)
router.post("/:id/homologations", authorizeRole(...QUALIF), createFournisseurHomologation)
router.patch("/:id/homologations/:homologationId", authorizeRole(...QUALIF), updateFournisseurHomologation)

// Catalogue.
router.get("/:id/catalogue", listFournisseurCatalogue)
router.post("/:id/catalogue", authorizeRole(...WRITE), createFournisseurCatalogueItem)
router.patch("/:id/catalogue/:catalogueId", authorizeRole(...WRITE), updateFournisseurCatalogueItem)
router.delete("/:id/catalogue/:catalogueId", authorizeRole(...WRITE), deleteFournisseurCatalogueItem)

// Documents.
router.get("/:id/documents", listFournisseurDocuments)
router.post("/:id/documents", authorizeRole(...WRITE), upload.array("documents[]"), attachFournisseurDocuments)
router.delete("/:id/documents/:docId", authorizeRole(...WRITE), removeFournisseurDocument)
router.get("/:id/documents/:docId/download", downloadFournisseurDocument)

export default router
