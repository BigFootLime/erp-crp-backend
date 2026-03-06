# Backend Project Map (erp-crp-backend)

Generated from repository inspection on 2026-03-05.

This file lives in `docs/frontend_repo_map.md` by request, but it documents the backend repository `erp-crp-backend`.

## A) Repo Structure Summary

### Stack

- Node.js + Express (`express`)
- TypeScript, strict mode (`tsconfig.json`, build to `dist/`)
- PostgreSQL via `pg` (raw SQL; no ORM)
- Zod validation (`zod`)
- Swagger UI for docs (`swagger-ui-express`) served at `/docs`
- Socket.IO realtime (`socket.io`)

### Entrypoints and Wiring

- HTTP bootstrap (creates HTTP server, initializes socket server, starts Postgres LISTEN bridge): `src/index.ts`
- Express app (global middlewares, routes mount, static serving, error handlers): `src/config/app.ts`
- API v1 router aggregator (mounts all module routers): `src/routes/v1.routes.ts`
- PostgreSQL connection pool: `src/config/database.ts`
- OpenAPI spec (hand-written, partial): `src/swagger/swagger.ts`

### Top-Level Folders

- `src/module/` domain modules (30 modules)
- `src/middlewares/` shared/global middlewares
- `src/utils/` shared helpers (errors, async handler, request metadata)
- `src/shared/` cross-cutting services (codes, realtime)
- `src/sockets/` Socket.IO server
- `db/patches/` idempotent SQL patch files (schema source for many modules)
- `scripts/` smoke/seed scripts
- `docs/` developer docs + HTTP examples
- `uploads/` runtime files (images, docs)

### Middleware Inventory

#### Global Express chain (wired in `src/config/app.ts`)

- `app.set("trust proxy", 1)` (reverse proxy support)
- `requestIdMiddleware` -> `src/middlewares/requestId.ts`
- `helmet()`
- `cors(corsOptionsDelegate)` + `app.options("*", cors(...))` (allowlist + `CORS_ORIGINS`)
- `requestLogger` -> `src/middlewares/requestLogger.ts`
- `morgan("dev")` in development
- Conditional JSON parser only for `Content-Type: application/json` (keeps multipart safe)
- `express.urlencoded(...)`
- Swagger UI mounted at `/docs` (`src/swagger/swagger.ts`)
- Health endpoints: `GET /` and `GET /api/v1`
- API mount: `app.use("/api/v1/", v1Router)` (`src/routes/v1.routes.ts`)
- Static images: `/images` from `uploads/images` (dev) or a network path (prod)
- `validationErrorMiddleware` (ZodError -> 400) -> `src/module/auth/middlewares/validationError.middleware.ts`
- Final error handler -> `src/middlewares/errorHandler.ts`

#### Shared middlewares (`src/middlewares/`)

- Request correlation id: `src/middlewares/requestId.ts`
- Structured request logs: `src/middlewares/requestLogger.ts`
- Shared multer storage for images: `src/middlewares/upload.ts`
- Generic Zod body validator helper: `src/middlewares/validate.ts` (`validateBody`)
- Final error handler: `src/middlewares/errorHandler.ts`
- ApiError-only handler (present but not wired by default): `src/middlewares/error.middleware.ts`

#### Module-level middleware patterns

- JWT auth + allowlist RBAC: `src/module/auth/middlewares/auth.middleware.ts` (`authenticateToken`, `authorizeRole`)
- Route-local role gates (inline RequestHandler functions in route files):
  - `requireAdmin` (production, pieces-techniques)
  - `requireProductionOrAdmin` (production, planning, programmation, quick-commande)
  - `requireQualityOrAdmin` (qualite)
- Route-local multipart parsing/validation:
  - `parseCommandeBody` in `src/module/commande-client/routes/commande-client.routes.ts`
  - `parseMultipartData(schema)` in `src/module/devis/routes/devis.routes.ts`

## B) Modules List

All modules are mounted under `/api/v1` via `src/routes/v1.routes.ts`.

| Module Dir | Mount Prefix | Route Files |
|---|---|---|
| `src/module/admin` | `/admin` | `src/module/admin/routes/admin.routes.ts` |
| `src/module/affaire` | `/affaires` | `src/module/affaire/routes/affaire.routes.ts` |
| `src/module/asbuilt` | `/asbuilt` | `src/module/asbuilt/routes/asbuilt.routes.ts` |
| `src/module/audit-logs` | `/audit-logs` | `src/module/audit-logs/routes/audit-logs.routes.ts` |
| `src/module/auth` | `/auth` | `src/module/auth/routes/auth.routes.ts` |
| `src/module/banking-info` | `/banking-info` | `src/module/banking-info/routes/banking-info.routes.ts` |
| `src/module/biller` | `/billers` | `src/module/biller/routes/biller.routes.ts` |
| `src/module/centre-frais` | `/centre-frais` | `src/module/centre-frais/routes/centre-frais.routes.ts` |
| `src/module/client` | `/clients` | `src/module/client/routes/client.routes.ts` |
| `src/module/codes` | `/codes` | `src/module/codes/routes/codes.routes.ts` |
| `src/module/commande-client` | `/commandes` | `src/module/commande-client/routes/commande-client.routes.ts` |
| `src/module/devis` | `/devis` | `src/module/devis/routes/devis.routes.ts` |
| `src/module/facturation` | `/factures`, `/avoirs`, `/paiements`, `/tarification`, `/reporting` | `src/module/facturation/routes/*.routes.ts` |
| `src/module/fournisseurs` | `/fournisseurs` | `src/module/fournisseurs/routes/fournisseurs.routes.ts` |
| `src/module/livraisons` | `/livraisons` | `src/module/livraisons/routes/livraisons.routes.ts` |
| `src/module/locks` | `/locks` | `src/module/locks/routes/locks.routes.ts` |
| `src/module/metrologie` | `/metrologie` | `src/module/metrologie/routes/metrologie.routes.ts` |
| `src/module/operation-dossiers` | `/dossiers` | `src/module/operation-dossiers/routes/operation-dossiers.routes.ts` |
| `src/module/outils` | `/outils` | `src/module/outils/routes/outil.routes.ts` |
| `src/module/payment-mode` | `/payment-modes` | `src/module/payment-mode/routes/payment-modes.routes.ts` |
| `src/module/pieces-families` | `/pieces-families` | `src/module/pieces-families/routes/pieces-families.routes.ts` |
| `src/module/pieces-techniques` | `/pieces-techniques` | `src/module/pieces-techniques/routes/pieces-techniques.routes.ts` |
| `src/module/planning` | `/planning` | `src/module/planning/routes/planning.routes.ts` |
| `src/module/production` | `/production` | `src/module/production/routes/production.routes.ts` |
| `src/module/programmation` | `/programmations` | `src/module/programmation/routes/programmation.routes.ts` |
| `src/module/qualite` | `/qualite` | `src/module/qualite/routes/qualite.routes.ts` |
| `src/module/quick-commande` | `/quick-commande` | `src/module/quick-commande/routes/quick-commande.routes.ts` |
| `src/module/receptions` | `/receptions` | `src/module/receptions/routes/receptions.routes.ts` |
| `src/module/stock` | `/stock` | `src/module/stock/routes/stock.routes.ts` |
| `src/module/traceability` | `/traceability` | `src/module/traceability/routes/traceability.routes.ts` |

## C) Entities List

### C.1 Domain Entities (TypeScript exports)

Exports from `src/module/**/types/*.types.ts` (type/interface/enum/class names):

- `src/module/affaire/types/affaire.types.ts`: `ClientLite`, `CommandeHeaderLite`, `DevisHeaderLite`, `Affaire`, `AffaireListItem`, `AffaireUpsertPayload`
- `src/module/asbuilt/types/asbuilt.types.ts`: `AsBuiltLotHeader`, `AsBuiltOfLite`, `AsBuiltBonLivraisonLite`, `AsBuiltNonConformityLite`, `AsBuiltPackVersion`, `AsBuiltPreview`, `AsBuiltGenerateResult`
- `src/module/audit-logs/types/audit-logs.types.ts`: `AuditEventType`, `AuditLogRow`, `Paginated`
- `src/module/auth/types/user.type.ts`: `CreateUserDTO` (interface)
- `src/module/banking-info/types/banking-info.types.ts`: `BankingInfo`, `CreateBankingInfoInput`
- `src/module/centre-frais/types/centre-frais.types.ts`: `PieceCF`, `CreatePieceCFInput`
- `src/module/client/types/client.types.ts`: `AddressInput`, `BankInline`, `PrimaryContactInput`, `ClientCreateInput`
- `src/module/commande-client/types/commande-client.types.ts`: `ClientLite`, `CommandeOrderType`, `CadreReleaseStatus`, `CommandeClient`, `CommandeListItem`, `CommandeCadreRelease`, `CommandeCadreReleaseLine`, `CommandeClientLine`, `CommandeEcheance`, `DocumentClient`, `CommandeDocument`, `CommandeHistorique`, `Affaire`, `CommandeToAffaire`, `CommandeLigneInput`, `CommandeEcheanceInput`, `CreateCommandeInput`, `CreateCadreReleaseInput`, `UpdateCadreReleasePatch`, `CreateCadreReleaseLineInput`, `UpdateCadreReleaseLinePatch`, `UploadedDocument`
- `src/module/devis/types/devis.types.ts`: `ClientLite`, `DocumentClient`, `DevisDocument`, `DevisLine`, `DevisHeader`, `DevisListItem`, `UploadedDocument`
- `src/module/facturation/types/avoirs.types.ts`: `FactureLite`, `AvoirHeader`, `AvoirLine`, `AvoirDocument`, `AvoirDetail`, `AvoirListItem`, `Paginated`
- `src/module/facturation/types/factures.types.ts`: `FactureHeader`, `FactureLine`, `FactureDocument`, `Paiement`, `FactureDetail`, `FactureListItem`, `Paginated`
- `src/module/facturation/types/paiements.types.ts`: `FactureLite`, `Paiement`, `PaiementListItem`, `Paginated`
- `src/module/facturation/types/shared.types.ts`: `ClientLite`, `DocumentClient`
- `src/module/facturation/types/tarification.types.ts`: `TarificationClient`, `TarificationClientListItem`, `Paginated`
- `src/module/fournisseurs/types/fournisseurs.types.ts`: `Paginated`, `Fournisseur`, `FournisseurListItem`, `FournisseurContact`, `FournisseurCatalogueType`, `FournisseurCatalogueItem`, `FournisseurDocument`
- `src/module/livraisons/types/livraisons.types.ts`: `Paginated`, `BonLivraisonStatut`, `UploadedDocument`, `UserLite`, `ClientLite`, `CommandeLite`, `AffaireLite`, `AdresseLivraisonLite`, `BonLivraisonListItem`, `BonLivraisonHeader`, `BonLivraisonLigne`, `BonLivraisonLigneAllocation`, `BonLivraisonDocument`, `BonLivraisonEventLog`, `BonLivraisonDetail`
- `src/module/livraisons/types/pack.types.ts`: `LivraisonPackCheck`, `LivraisonPackStockMovement`, `LivraisonPackAllocation`, `LivraisonPackLine`, `LivraisonPackVersionStatus`, `LivraisonPackVersion`, `LivraisonPackPreview`, `LivraisonPackGenerateResult`
- `src/module/locks/types/locks.types.ts`: `UserRef`, `EntityLock`, `LockUpdatedPayload`
- `src/module/metrologie/types/metrologie.types.ts`: `Paginated`, `UserLite`, `MetrologieCriticite`, `MetrologieEquipementStatut`, `MetrologiePlanStatut`, `MetrologieCertificatResultat`, `MetrologieEquipement`, `MetrologiePlan`, `MetrologieCertificat`, `MetrologieEventLog`, `MetrologieEquipementListItem`, `MetrologieEquipementDetail`, `MetrologieKpis`, `MetrologieAlertItem`, `MetrologieAlerts`, `MetrologieAlertsSummary`
- `src/module/operation-dossiers/types/operation-dossiers.types.ts`: `OperationDossierOperationType`, `OperationDossierType`, `UserLite`, `OperationDossierHeader`, `OperationDossierVersionDocument`, `OperationDossierVersion`, `OperationDossierOperationResponse`, `CreateOperationDossierVersionResult`
- `src/module/outils/types/outil.types.ts`: (no exported type/interface/enum/class declarations)
- `src/module/payment-mode/types/payment-mode.types.ts`: `PaymentMode`, `CreatePaymentModeInput`
- `src/module/pieces-families/types/pieces-families.types.ts`: `PieceFamily`, `CreatePieceFamilyInput`
- `src/module/pieces-techniques/types/pieces-techniques.types.ts`: `BomLine`, `PieceTechniqueStatut`, `PieceTechniqueHistoryEntry`, `PieceTechniqueDocument`, `PieceTechniqueAffaireLink`, `AffairePieceTechniqueLink`, `Operation`, `Achat`, `PieceTechnique`, `CreatePieceTechniqueInput`, `PieceTechniqueListItem`, `Paginated`, `PiecesTechniquesStats`
- `src/module/planning/types/planning.types.ts`: `PlanningEventKind`, `PlanningEventStatus`, `PlanningPriority`, `PlanningMachineResource`, `PlanningPosteResource`, `PlanningResources`, `PlanningEventListItem`, `PlanningEventComment`, `PlanningEventDocument`, `PlanningEventDetail`, `Paginated`
- `src/module/production/types/pointages.types.ts`: `PointageTimeType`, `PointageStatus`, `PointageUserLite`, `PointageMachineLite`, `PointagePosteLite`, `PointageOfLite`, `PointageAffaireLite`, `PointagePieceTechniqueLite`, `PointageOperationLite`, `ProductionPointageListItem`, `ProductionPointageEvent`, `ProductionPointageDetail`, `ProductionPointagesKpis`
- `src/module/production/types/production-groups.types.ts`: `ProductionGroup`, `ProductionGroupListItem`, `AffaireLite`, `OfLite`, `ProductionGroupDetail`
- `src/module/production/types/production.types.ts`: `Paginated`, `MachineListItem`, `MachineDetail`, `PosteListItem`, `PosteDetail`, `OrdreFabricationListItem`, `OfTimeLog`, `OfOperation`, `OrdreFabricationDetail`
- `src/module/programmation/types/programmation.types.ts`: `ProgrammationTaskListItem`, `Paginated`
- `src/module/qualite/types/qualite.types.ts`: `Paginated`, `QualityControlType`, `QualityControlStatus`, `QualityControlResult`, `QualityPointResult`, `NonConformitySeverity`, `NonConformityStatus`, `NonConformityDispositionType`, `QualityActionType`, `QualityActionStatus`, `QualityEntityType`, `QualityDocumentType`, `QualityUserLite`, `QualityMachineLite`, `QualityPosteLite`, `QualityOfLite`, `QualityAffaireLite`, `QualityPieceTechniqueLite`, `QualityOperationLite`, `QualityControlPoint`, `QualityDocument`, `QualityEventLog`, `QualityControlListItem`, `QualityControlDetail`, `NonConformityListItem`, `NonConformityDetail`, `NonConformityDisposition`, `QualityActionListItem`, `QualityActionDetail`, `QualityKpis`
- `src/module/quick-commande/types/quick-commande.types.ts`: `QuickCommandeResource`, `QuickCommandePlannedOperation`, `QuickCommandePreviewPlan`, `QuickCommandePreviewResponse`, `QuickCommandeConfirmResponse`
- `src/module/receptions/types/receptions.types.ts`: `Paginated`, `ReceptionFournisseurStatus`, `LotStatus`, `IncomingInspectionStatus`, `IncomingInspectionDecision`, `ReceptionFournisseur`, `ReceptionFournisseurListItem`, `ReceptionFournisseurLine`, `ReceptionFournisseurDocument`, `ReceptionIncomingInspection`, `ReceptionIncomingMeasurement`, `ReceptionStockReceipt`, `ReceptionKpis`, `ReceptionFournisseurDetail`
- `src/module/stock/types/stock.types.ts`: `Paginated`, `ArticleType`, `StockArticleListItem`, `StockArticleDetail`, `StockArticleKpis`, `StockMagasinListItem`, `StockMagasinDetail`, `StockMagasinKpis`, `StockEmplacementListItem`, `StockLotListItem`, `StockLotDetail`, `StockBalanceRow`, `StockMovementType`, `StockMovementStatus`, `StockMovementListItem`, `StockMovementLineDetail`, `StockDocument`, `StockMovementEvent`, `StockMovementDetail`, `StockMovementKpis`, `StockInventorySessionStatus`, `StockInventorySessionListItem`, `StockInventorySessionLine`, `StockInventorySessionDetail`
- `src/module/traceability/types/traceability.types.ts`: `TraceabilityNodeType`, `TraceabilityNodeRef`, `TraceabilityNodeId`, `TraceabilityNode`, `TraceabilityEdge`, `TraceabilityHighlight`, `TraceabilityChainResult`

### C.2 Database Entities (tables/functions/types)

#### Patch-defined schema (from `db/patches/*.sql`)

There are 33 SQL patch files under `db/patches/`. They define:

- Tables (74):

```text
public.affaire_pieces_techniques
public.article_documents
public.articles
public.asbuilt_pack_versions
public.bon_livraison
public.bon_livraison_documents
public.bon_livraison_event_log
public.bon_livraison_ligne
public.bon_livraison_ligne_allocations
public.bon_livraison_pack_versions
public.code_sequences
public.commande_cadre_release
public.commande_cadre_release_ligne
public.commande_client_event_log
public.commande_ligne_affaire_allocation
public.emplacements
public.entity_locks
public.erp_settings
public.fournisseur_catalogue
public.fournisseur_contacts
public.fournisseur_documents
public.fournisseurs
public.lots
public.machines
public.magasins
public.metrologie_certificats
public.metrologie_equipements
public.metrologie_event_log
public.metrologie_plan
public.non_conformity
public.non_conformity_dispositions
public.of_operations
public.of_quality_logs
public.of_time_logs
public.operation_dossier_version_documents
public.operation_dossier_versions
public.operation_dossiers
public.ordres_fabrication
public.password_reset_tokens
public.password_resets
public.pieces_techniques
public.pieces_techniques_achats
public.pieces_techniques_documents
public.pieces_techniques_historique
public.pieces_techniques_nomenclature
public.pieces_techniques_operations
public.planning_event_comments
public.planning_event_documents
public.planning_events
public.postes
public.production_group
public.production_pointage_events
public.production_pointages
public.programmations
public.quality_action
public.quality_control
public.quality_control_points
public.quality_documents
public.quality_event_log
public.quick_commande_confirmations
public.quick_commande_previews
public.reception_fournisseur_documents
public.reception_fournisseur_lignes
public.reception_fournisseur_stock_receipts
public.reception_incoming_inspections
public.reception_incoming_measurements
public.receptions_fournisseurs
public.stock_balances
public.stock_documents
public.stock_inventory_lines
public.stock_inventory_session_movements
public.stock_inventory_sessions
public.stock_ledger
public.stock_movement_documents
public.stock_movement_event_log
public.stock_movement_lines
public.stock_movements
public.stock_reservations
public.traceability_links
```

- Functions / triggers (5):

```text
public.fn_apply_stock_movement
public.fn_next_code_value
public.quality_generate_action_reference
public.quality_generate_nc_reference
public.tg_set_production_pointage_duration_minutes
```

- Enum types (21):

```text
public.machine_status
public.machine_type
public.of_operation_status
public.of_priority
public.of_status
public.of_time_log_type
public.planning_event_kind
public.planning_event_status
public.planning_priority
public.production_pointage_status
public.production_pointage_time_type
public.quality_action_status
public.quality_action_type
public.quality_control_result
public.quality_control_status
public.quality_control_type
public.quality_document_type
public.quality_entity_type
public.quality_nc_severity
public.quality_nc_status
public.quality_point_result
```

#### Additional tables referenced by repositories (legacy / pre-existing)

Multiple repositories issue SQL against tables not created in `db/patches/`. These appear to be part of an older/pre-existing schema.
Examples (non-exhaustive, based on repository queries):

- Clients: `clients`, `contacts`, `adresse_facturation`, `adresse_livraison`, `informations_bancaires`, `client_payment_modes`
- Devis: `devis`, `devis_ligne`, `devis_documents`, `documents_clients`
- Commandes: `commande_client`, `commande_ligne`, `commande_documents`, `commande_historique`, `commande_echeance`, `commande_to_affaire`
- Facturation: `facture`, `facture_ligne`, `facture_documents`, `avoir`, `avoir_ligne`, `avoir_documents`, `paiement`
- Reference: `mode_reglement`, `factureur`
- Audit: `erp_audit_logs` (written by code; see `src/module/audit-logs/repository/audit-logs.repository.ts`)
- Outils legacy: `gestion_outils_*` tables (see `src/module/outils/repository/outil.repository.ts`)

## D) Routes Table (method, path, middleware, validation)

Notes:

- Global middleware chain applies to all routes via `src/config/app.ts` (request id, helmet, cors, logging, parsers, etc.).
- `VALIDATION=validate(...)` / `parseMultipartData(...).safeParse` / `parseCommandeBody(...)` indicates route-level validation.
- `VALIDATION=controller` means validation happens in the controller (common in modules like `auth`, `production`, `client`, etc.) or there is no explicit Zod guard at the route level.

Full inventory (parsed from `src/module/**/routes/*.routes.ts`, mounted under `/api/v1` by `src/routes/v1.routes.ts`):

```tsv
METHOD	PATH	MIDDLEWARE	VALIDATION
GET	/api/v1/admin/analytics	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
GET	/api/v1/admin/login-logs	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
GET	/api/v1/admin/users	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
POST	/api/v1/admin/users	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
DELETE	/api/v1/admin/users/:id	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
GET	/api/v1/admin/users/:id	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
PATCH	/api/v1/admin/users/:id	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
PATCH	/api/v1/admin/users/:id/password	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
POST	/api/v1/admin/users/:id/password-reset-token	authenticateToken, authorizeRole("Administrateur Systeme et Reseau", "Directeur")	controller
GET	/api/v1/affaires	-	controller
POST	/api/v1/affaires	-	controller
DELETE	/api/v1/affaires/:id	-	controller
GET	/api/v1/affaires/:id	-	controller
PATCH	/api/v1/affaires/:id	-	controller
GET	/api/v1/asbuilt/lots/:lotId/download/:documentId	authenticateToken	controller
POST	/api/v1/asbuilt/lots/:lotId/generate	authenticateToken	controller
GET	/api/v1/asbuilt/lots/:lotId/preview	authenticateToken	controller
GET	/api/v1/audit-logs	authenticateToken	controller
POST	/api/v1/audit-logs	authenticateToken	controller
POST	/api/v1/auth/forgot-password	-	controller
POST	/api/v1/auth/login	-	controller
GET	/api/v1/auth/me	authenticateToken, authorizeRole('Administrateur Systeme et Reseau', 'Directeur')	controller
POST	/api/v1/auth/register	-	controller
POST	/api/v1/auth/reset-password	-	controller
GET	/api/v1/avoirs	-	controller
POST	/api/v1/avoirs	-	controller
DELETE	/api/v1/avoirs/:id	-	controller
GET	/api/v1/avoirs/:id	-	controller
PATCH	/api/v1/avoirs/:id	-	controller
GET	/api/v1/avoirs/:id/pdf	-	controller
POST	/api/v1/avoirs/:id/pdf	-	controller
GET	/api/v1/banking-info	-	controller
POST	/api/v1/banking-info	validate(createBankingInfoSchema)	validate(createBankingInfoSchema)
DELETE	/api/v1/banking-info/:id	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/banking-info/:id	validate(idParamSchema)	validate(idParamSchema)
PATCH	/api/v1/banking-info/:id	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/billers	-	controller
GET	/api/v1/centre-frais	-	controller
POST	/api/v1/centre-frais	validate(createPieceCFSchema)	validate(createPieceCFSchema)
DELETE	/api/v1/centre-frais/:id	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/centre-frais/:id	validate(idParamSchema)	validate(idParamSchema)
PATCH	/api/v1/centre-frais/:id	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/clients	-	controller
POST	/api/v1/clients	authenticateToken	controller
GET	/api/v1/clients/:clientId/addresses	-	controller
GET	/api/v1/clients/:clientId/contacts	-	controller
DELETE	/api/v1/clients/:id	authenticateToken	controller
GET	/api/v1/clients/:id	-	controller
PATCH	/api/v1/clients/:id	authenticateToken	controller
POST	/api/v1/clients/:id/archive	authenticateToken	controller
PATCH	/api/v1/clients/:id/contact	authenticateToken	controller
GET	/api/v1/clients/analytics	-	controller
GET	/api/v1/codes/formats	authenticateToken	controller
GET	/api/v1/commandes	-	controller
POST	/api/v1/commandes	upload.array("documents[]"), parseCommandeBody	parseCommandeBody(createCommandeBodySchema.safeParse)
DELETE	/api/v1/commandes/:id	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/commandes/:id	validate(idParamSchema)	validate(idParamSchema)
PATCH	/api/v1/commandes/:id	validate(idParamSchema), upload.array("documents[]"), parseCommandeBody	validate(idParamSchema) + parseCommandeBody(createCommandeBodySchema.safeParse)
POST	/api/v1/commandes/:id/affaires/generate	validate(generateAffairesSchema)	validate(generateAffairesSchema)
POST	/api/v1/commandes/:id/affaires/preview	validate(idParamSchema)	validate(idParamSchema)
POST	/api/v1/commandes/:id/analyze-stock	authenticateToken, validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/commandes/:id/documents/:docId/file	validate(documentIdParamSchema)	validate(documentIdParamSchema)
POST	/api/v1/commandes/:id/duplicate	validate(idParamSchema)	validate(idParamSchema)
POST	/api/v1/commandes/:id/generate-affaires	authenticateToken, validate(generateAffairesV3Schema)	validate(generateAffairesV3Schema)
POST	/api/v1/commandes/:id/generate-affaires/confirm	validate(confirmGenerateAffairesSchema)	validate(confirmGenerateAffairesSchema)
GET	/api/v1/commandes/:id/releases	validate(idParamSchema)	validate(idParamSchema)
POST	/api/v1/commandes/:id/releases	validate(idParamSchema)	validate(idParamSchema)
DELETE	/api/v1/commandes/:id/releases/:releaseId	validate(releaseIdParamSchema)	validate(releaseIdParamSchema)
GET	/api/v1/commandes/:id/releases/:releaseId	validate(releaseIdParamSchema)	validate(releaseIdParamSchema)
PATCH	/api/v1/commandes/:id/releases/:releaseId	validate(releaseIdParamSchema)	validate(releaseIdParamSchema)
POST	/api/v1/commandes/:id/releases/:releaseId/lines	validate(releaseIdParamSchema)	validate(releaseIdParamSchema)
DELETE	/api/v1/commandes/:id/releases/:releaseId/lines/:lineId	validate(releaseLineIdParamSchema)	validate(releaseLineIdParamSchema)
PATCH	/api/v1/commandes/:id/releases/:releaseId/lines/:lineId	validate(releaseLineIdParamSchema)	validate(releaseLineIdParamSchema)
POST	/api/v1/commandes/:id/releases/:releaseId/status	validate(releaseIdParamSchema)	validate(releaseIdParamSchema)
POST	/api/v1/commandes/:id/status	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/devis	-	controller
POST	/api/v1/devis	upload.array("documents[]"), parseMultipartData(createDevisBodySchema)	parseMultipartData(createDevisBodySchema).safeParse
DELETE	/api/v1/devis/:id	-	controller
GET	/api/v1/devis/:id	-	controller
PATCH	/api/v1/devis/:id	upload.array("documents[]"), parseMultipartData(updateDevisBodySchema)	parseMultipartData(updateDevisBodySchema).safeParse
POST	/api/v1/devis/:id/convert-to-commande	-	controller
GET	/api/v1/devis/:id/documents/:docId/file	-	controller
POST	/api/v1/dossiers/:dossierId/versions	authenticateToken, upload.any()	controller
GET	/api/v1/dossiers/documents/:documentId/download	authenticateToken	controller
GET	/api/v1/dossiers/operation	authenticateToken	controller
GET	/api/v1/factures	-	controller
POST	/api/v1/factures	-	controller
DELETE	/api/v1/factures/:id	-	controller
GET	/api/v1/factures/:id	-	controller
PATCH	/api/v1/factures/:id	-	controller
GET	/api/v1/factures/:id/pdf	-	controller
POST	/api/v1/factures/:id/pdf	-	controller
GET	/api/v1/fournisseurs	authenticateToken	controller
POST	/api/v1/fournisseurs	authenticateToken	controller
GET	/api/v1/fournisseurs/:id	authenticateToken	controller
PATCH	/api/v1/fournisseurs/:id	authenticateToken	controller
GET	/api/v1/fournisseurs/:id/catalogue	authenticateToken	controller
POST	/api/v1/fournisseurs/:id/catalogue	authenticateToken	controller
DELETE	/api/v1/fournisseurs/:id/catalogue/:catalogueId	authenticateToken	controller
PATCH	/api/v1/fournisseurs/:id/catalogue/:catalogueId	authenticateToken	controller
GET	/api/v1/fournisseurs/:id/contacts	authenticateToken	controller
POST	/api/v1/fournisseurs/:id/contacts	authenticateToken	controller
DELETE	/api/v1/fournisseurs/:id/contacts/:contactId	authenticateToken	controller
PATCH	/api/v1/fournisseurs/:id/contacts/:contactId	authenticateToken	controller
POST	/api/v1/fournisseurs/:id/deactivate	authenticateToken	controller
GET	/api/v1/fournisseurs/:id/documents	authenticateToken	controller
POST	/api/v1/fournisseurs/:id/documents	authenticateToken, upload.array("documents[]")	controller
DELETE	/api/v1/fournisseurs/:id/documents/:docId	authenticateToken	controller
GET	/api/v1/fournisseurs/:id/documents/:docId/download	authenticateToken	controller
GET	/api/v1/livraisons	authenticateToken	controller
POST	/api/v1/livraisons	authenticateToken	controller
GET	/api/v1/livraisons/:id	authenticateToken	controller
PUT	/api/v1/livraisons/:id	authenticateToken	controller
POST	/api/v1/livraisons/:id/documents	authenticateToken, upload.array("documents[]")	controller
DELETE	/api/v1/livraisons/:id/documents/:docId	authenticateToken	controller
GET	/api/v1/livraisons/:id/documents/:docId/file	authenticateToken	controller
POST	/api/v1/livraisons/:id/lignes/:lineId/allocations	authenticateToken	controller
DELETE	/api/v1/livraisons/:id/lignes/:lineId/allocations/:allocationId	authenticateToken	controller
POST	/api/v1/livraisons/:id/lines	authenticateToken	controller
DELETE	/api/v1/livraisons/:id/lines/:lineId	authenticateToken	controller
PUT	/api/v1/livraisons/:id/lines/:lineId	authenticateToken	controller
GET	/api/v1/livraisons/:id/pack/download/:documentId	authenticateToken	controller
POST	/api/v1/livraisons/:id/pack/generate	authenticateToken	controller
GET	/api/v1/livraisons/:id/pack/preview	authenticateToken	controller
POST	/api/v1/livraisons/:id/pack/revoke/:versionId	authenticateToken	controller
GET	/api/v1/livraisons/:id/pdf	authenticateToken	controller
POST	/api/v1/livraisons/:id/pdf	authenticateToken	controller
POST	/api/v1/livraisons/:id/status	authenticateToken	controller
POST	/api/v1/livraisons/from-commande/:commandeId	authenticateToken	controller
POST	/api/v1/locks/acquire	authenticateToken	controller
POST	/api/v1/locks/heartbeat	authenticateToken	controller
POST	/api/v1/locks/release	authenticateToken	controller
GET	/api/v1/metrologie/alerts	authenticateToken	controller
GET	/api/v1/metrologie/alerts/summary	authenticateToken	controller
GET	/api/v1/metrologie/equipements	authenticateToken	controller
POST	/api/v1/metrologie/equipements	authenticateToken	controller
DELETE	/api/v1/metrologie/equipements/:id	authenticateToken	controller
GET	/api/v1/metrologie/equipements/:id	authenticateToken	controller
PATCH	/api/v1/metrologie/equipements/:id	authenticateToken	controller
GET	/api/v1/metrologie/equipements/:id/certificats	authenticateToken	controller
POST	/api/v1/metrologie/equipements/:id/certificats	authenticateToken, upload.array("documents[]")	controller
DELETE	/api/v1/metrologie/equipements/:id/certificats/:certificatId	authenticateToken	controller
GET	/api/v1/metrologie/equipements/:id/certificats/:certificatId/file	authenticateToken	controller
PUT	/api/v1/metrologie/equipements/:id/plan	authenticateToken	controller
GET	/api/v1/metrologie/kpis	authenticateToken	controller
GET	/api/v1/outils	-	controller
POST	/api/v1/outils	authenticateToken, upload.fields([ { name: "esquisse", maxCount: 1 }, { name: "plan", maxCount: 1 }, { name: "image", maxCount: 1 }, ])	controller
GET	/api/v1/outils/:id	-	controller
GET	/api/v1/outils/aretes	-	controller
GET	/api/v1/outils/fabricants	-	controller
POST	/api/v1/outils/fabricants	authenticateToken, upload.single("logo")	controller
GET	/api/v1/outils/familles	-	controller
GET	/api/v1/outils/fournisseurs	-	controller
POST	/api/v1/outils/fournisseurs	authenticateToken	controller
GET	/api/v1/outils/geometries	-	controller
POST	/api/v1/outils/inventaire/set	authenticateToken	controller
GET	/api/v1/outils/low-stock	authenticateToken	controller
POST	/api/v1/outils/reapprovisionner	authenticateToken	controller
GET	/api/v1/outils/ref_fabricant/:ref_fabricant	-	controller
GET	/api/v1/outils/revetements	-	controller
POST	/api/v1/outils/revetements	authenticateToken	controller
POST	/api/v1/outils/scan/entree	authenticateToken	controller
POST	/api/v1/outils/scan/sortie	authenticateToken	controller
POST	/api/v1/outils/sortie	authenticateToken	controller
GET	/api/v1/paiements	-	controller
POST	/api/v1/paiements	-	controller
DELETE	/api/v1/paiements/:id	-	controller
GET	/api/v1/paiements/:id	-	controller
PATCH	/api/v1/paiements/:id	-	controller
GET	/api/v1/payment-modes	-	controller
POST	/api/v1/payment-modes	-	controller
GET	/api/v1/pieces-families	-	controller
POST	/api/v1/pieces-families	validate(createPieceFamilySchema)	validate(createPieceFamilySchema)
DELETE	/api/v1/pieces-families/:id	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/pieces-families/:id	validate(idParamSchema)	validate(idParamSchema)
PATCH	/api/v1/pieces-families/:id	validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/pieces-techniques	authenticateToken	controller
POST	/api/v1/pieces-techniques	authenticateToken, validate(createPieceTechniqueSchema)	validate(createPieceTechniqueSchema)
DELETE	/api/v1/pieces-techniques/:id	authenticateToken, requireAdmin, validate(idParamSchema)	validate(idParamSchema)
GET	/api/v1/pieces-techniques/:id	authenticateToken, validate(idParamSchema)	validate(idParamSchema)
PATCH	/api/v1/pieces-techniques/:id	authenticateToken, validate(idParamSchema), validate(updatePieceTechniqueSchema)	validate(idParamSchema) + validate(updatePieceTechniqueSchema)
POST	/api/v1/pieces-techniques/:id/achats	authenticateToken, validate(idParamSchema), validate(addAchatSchema)	validate(idParamSchema) + validate(addAchatSchema)
DELETE	/api/v1/pieces-techniques/:id/achats/:achatId	authenticateToken, validate(achatIdParamSchema)	validate(achatIdParamSchema)
PATCH	/api/v1/pieces-techniques/:id/achats/:achatId	authenticateToken, validate(achatIdParamSchema), validate(updateAchatSchema)	validate(achatIdParamSchema) + validate(updateAchatSchema)
POST	/api/v1/pieces-techniques/:id/achats/reorder	authenticateToken, validate(idParamSchema), validate(reorderSchema)	validate(idParamSchema) + validate(reorderSchema)
GET	/api/v1/pieces-techniques/:id/affaires	authenticateToken, validate(idParamSchema)	validate(idParamSchema)
POST	/api/v1/pieces-techniques/:id/affaires	authenticateToken, validate(idParamSchema), validate(linkAffaireSchema)	validate(idParamSchema) + validate(linkAffaireSchema)
DELETE	/api/v1/pieces-techniques/:id/affaires/:affaireId	authenticateToken, validate(affaireIdParamSchema)	validate(affaireIdParamSchema)
GET	/api/v1/pieces-techniques/:id/documents	authenticateToken, validate(idParamSchema)	validate(idParamSchema)
POST	/api/v1/pieces-techniques/:id/documents	authenticateToken, validate(idParamSchema), upload.array("documents[]")	validate(idParamSchema)
DELETE	/api/v1/pieces-techniques/:id/documents/:docId	authenticateToken, validate(documentIdParamSchema)	validate(documentIdParamSchema)
GET	/api/v1/pieces-techniques/:id/documents/:docId/file	authenticateToken, validate(documentIdParamSchema)	validate(documentIdParamSchema)
POST	/api/v1/pieces-techniques/:id/duplicate	authenticateToken, validate(idParamSchema)	validate(idParamSchema)
POST	/api/v1/pieces-techniques/:id/nomenclature	authenticateToken, validate(idParamSchema), validate(addBomLineSchema)	validate(idParamSchema) + validate(addBomLineSchema)
DELETE	/api/v1/pieces-techniques/:id/nomenclature/:lineId	authenticateToken, validate(bomLineIdParamSchema)	validate(bomLineIdParamSchema)
PATCH	/api/v1/pieces-techniques/:id/nomenclature/:lineId	authenticateToken, validate(bomLineIdParamSchema), validate(updateBomLineSchema)	validate(bomLineIdParamSchema) + validate(updateBomLineSchema)
POST	/api/v1/pieces-techniques/:id/nomenclature/reorder	authenticateToken, validate(idParamSchema), validate(reorderSchema)	validate(idParamSchema) + validate(reorderSchema)
POST	/api/v1/pieces-techniques/:id/operations	authenticateToken, validate(idParamSchema), validate(addOperationSchema)	validate(idParamSchema) + validate(addOperationSchema)
DELETE	/api/v1/pieces-techniques/:id/operations/:opId	authenticateToken, validate(operationIdParamSchema)	validate(operationIdParamSchema)
PATCH	/api/v1/pieces-techniques/:id/operations/:opId	authenticateToken, validate(operationIdParamSchema), validate(updateOperationSchema)	validate(operationIdParamSchema) + validate(updateOperationSchema)
POST	/api/v1/pieces-techniques/:id/operations/reorder	authenticateToken, validate(idParamSchema), validate(reorderSchema)	validate(idParamSchema) + validate(reorderSchema)
POST	/api/v1/pieces-techniques/:id/status	authenticateToken, validate(idParamSchema), validate(pieceTechniqueStatusSchema)	validate(idParamSchema) + validate(pieceTechniqueStatusSchema)
GET	/api/v1/pieces-techniques/by-affaire/:affaireId	authenticateToken, validate(affaireOnlyParamSchema)	validate(affaireOnlyParamSchema)
POST	/api/v1/planning/autoplan	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/planning/events	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/planning/events	authenticateToken, requireProductionOrAdmin	controller
DELETE	/api/v1/planning/events/:id	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/planning/events/:id	authenticateToken, requireProductionOrAdmin	controller
PATCH	/api/v1/planning/events/:id	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/planning/events/:id/comments	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/planning/events/:id/documents	authenticateToken, requireProductionOrAdmin, uploadDocs.array("documents[]")	controller
GET	/api/v1/planning/events/:id/documents/:docId/file	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/planning/health	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/planning/resources	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/production/groups	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/production/groups	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/production/groups/:id	authenticateToken, requireProductionOrAdmin	controller
PATCH	/api/v1/production/groups/:id	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/production/groups/:id/link	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/production/groups/:id/unlink	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/production/machines	authenticateToken	controller
POST	/api/v1/production/machines	authenticateToken, upload.single("image")	controller
DELETE	/api/v1/production/machines/:id	authenticateToken, requireAdmin	controller
GET	/api/v1/production/machines/:id	authenticateToken	controller
PATCH	/api/v1/production/machines/:id	authenticateToken, upload.single("image")	controller
GET	/api/v1/production/ofs	authenticateToken	controller
POST	/api/v1/production/ofs	authenticateToken	controller
GET	/api/v1/production/ofs/:id	authenticateToken	controller
PATCH	/api/v1/production/ofs/:id	authenticateToken	controller
PATCH	/api/v1/production/ofs/:id/operations/:opId	authenticateToken	controller
POST	/api/v1/production/ofs/:id/operations/:opId/time-logs/start	authenticateToken	controller
POST	/api/v1/production/ofs/:id/operations/:opId/time-logs/stop	authenticateToken	controller
POST	/api/v1/production/ofs/:id/receipt	authenticateToken	controller
GET	/api/v1/production/ofs/:id/receipt-context	authenticateToken	controller
GET	/api/v1/production/ofs/:id/traceability	authenticateToken	controller
GET	/api/v1/production/operators	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/production/pointages	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/production/pointages	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/production/pointages/:id	authenticateToken, requireProductionOrAdmin	controller
PATCH	/api/v1/production/pointages/:id	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/production/pointages/:id/start	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/production/pointages/:id/stop	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/production/pointages/:id/validate	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/production/pointages/kpis	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/production/postes	authenticateToken	controller
POST	/api/v1/production/postes	authenticateToken	controller
DELETE	/api/v1/production/postes/:id	authenticateToken, requireAdmin	controller
GET	/api/v1/production/postes/:id	authenticateToken	controller
PATCH	/api/v1/production/postes/:id	authenticateToken	controller
GET	/api/v1/programmations	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/programmations/health	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/qualite/actions	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/actions	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/actions/:id	authenticateToken, requireQualityOrAdmin	controller
PATCH	/api/v1/qualite/actions/:id	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/actions/:id/documents	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/actions/:id/documents	authenticateToken, requireQualityOrAdmin, upload.array("documents[]")	controller
DELETE	/api/v1/qualite/actions/:id/documents/:docId	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/actions/:id/documents/:docId/file	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/controls	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/controls	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/controls/:id	authenticateToken, requireQualityOrAdmin	controller
PATCH	/api/v1/qualite/controls/:id	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/controls/:id/documents	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/controls/:id/documents	authenticateToken, requireQualityOrAdmin, upload.array("documents[]")	controller
DELETE	/api/v1/qualite/controls/:id/documents/:docId	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/controls/:id/documents/:docId/file	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/controls/:id/validate	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/dashboard	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/kpis	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/non-conformities	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/non-conformities	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/non-conformities/:id	authenticateToken, requireQualityOrAdmin	controller
PATCH	/api/v1/qualite/non-conformities/:id	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/non-conformities/:id/dispositions	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/non-conformities/:id/dispositions	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/non-conformities/:id/documents	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/non-conformities/:id/documents	authenticateToken, requireQualityOrAdmin, upload.array("documents[]")	controller
DELETE	/api/v1/qualite/non-conformities/:id/documents/:docId	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/non-conformities/:id/documents/:docId/file	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/qualite/non-conformities/:id/status	authenticateToken, requireQualityOrAdmin	controller
GET	/api/v1/qualite/users	authenticateToken, requireQualityOrAdmin	controller
POST	/api/v1/quick-commande/confirm	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/quick-commande/health	authenticateToken, requireProductionOrAdmin	controller
POST	/api/v1/quick-commande/preview	authenticateToken, requireProductionOrAdmin	controller
GET	/api/v1/receptions	authenticateToken	controller
POST	/api/v1/receptions	authenticateToken	controller
GET	/api/v1/receptions/:id	authenticateToken	controller
PATCH	/api/v1/receptions/:id	authenticateToken	controller
POST	/api/v1/receptions/:id/documents	authenticateToken, upload.array("documents[]")	controller
DELETE	/api/v1/receptions/:id/documents/:docId	authenticateToken	controller
GET	/api/v1/receptions/:id/documents/:docId/download	authenticateToken	controller
POST	/api/v1/receptions/:id/lines	authenticateToken	controller
POST	/api/v1/receptions/:id/lines/:lineId/create-lot	authenticateToken	controller
POST	/api/v1/receptions/:id/lines/:lineId/inspection/decide	authenticateToken	controller
POST	/api/v1/receptions/:id/lines/:lineId/inspection/measurements	authenticateToken	controller
POST	/api/v1/receptions/:id/lines/:lineId/inspection/start	authenticateToken	controller
POST	/api/v1/receptions/:id/lines/:lineId/stock-receipt	authenticateToken	controller
GET	/api/v1/receptions/kpis	authenticateToken	controller
GET	/api/v1/reporting/commercial/outstanding	-	controller
GET	/api/v1/reporting/commercial/revenue	-	controller
GET	/api/v1/reporting/commercial/top-clients	-	controller
GET	/api/v1/stock/articles	authenticateToken	controller
POST	/api/v1/stock/articles	authenticateToken	controller
GET	/api/v1/stock/articles/:id	authenticateToken	controller
PATCH	/api/v1/stock/articles/:id	authenticateToken	controller
GET	/api/v1/stock/articles/:id/documents	authenticateToken	controller
POST	/api/v1/stock/articles/:id/documents	authenticateToken, upload.array("documents[]")	controller
DELETE	/api/v1/stock/articles/:id/documents/:docId	authenticateToken	controller
GET	/api/v1/stock/articles/:id/documents/:docId/file	authenticateToken	controller
GET	/api/v1/stock/articles/kpis	authenticateToken	controller
GET	/api/v1/stock/balances	authenticateToken	controller
GET	/api/v1/stock/emplacements	authenticateToken	controller
PATCH	/api/v1/stock/emplacements/:id	authenticateToken	controller
GET	/api/v1/stock/inventory-sessions	authenticateToken	controller
POST	/api/v1/stock/inventory-sessions	authenticateToken	controller
GET	/api/v1/stock/inventory-sessions/:id	authenticateToken	controller
POST	/api/v1/stock/inventory-sessions/:id/close	authenticateToken	controller
GET	/api/v1/stock/inventory-sessions/:id/lines	authenticateToken	controller
PUT	/api/v1/stock/inventory-sessions/:id/lines	authenticateToken	controller
GET	/api/v1/stock/lots	authenticateToken	controller
POST	/api/v1/stock/lots	authenticateToken	controller
GET	/api/v1/stock/lots/:id	authenticateToken	controller
PATCH	/api/v1/stock/lots/:id	authenticateToken	controller
GET	/api/v1/stock/magasins	authenticateToken	controller
POST	/api/v1/stock/magasins	authenticateToken	controller
GET	/api/v1/stock/magasins/:id	authenticateToken	controller
PATCH	/api/v1/stock/magasins/:id	authenticateToken	controller
POST	/api/v1/stock/magasins/:id/activate	authenticateToken	controller
POST	/api/v1/stock/magasins/:id/deactivate	authenticateToken	controller
POST	/api/v1/stock/magasins/:magasinId/emplacements	authenticateToken	controller
GET	/api/v1/stock/magasins/kpis	authenticateToken	controller
GET	/api/v1/stock/movements	authenticateToken	controller
POST	/api/v1/stock/movements	authenticateToken	controller
GET	/api/v1/stock/movements/:id	authenticateToken	controller
POST	/api/v1/stock/movements/:id/cancel	authenticateToken	controller
GET	/api/v1/stock/movements/:id/documents	authenticateToken	controller
POST	/api/v1/stock/movements/:id/documents	authenticateToken, upload.array("documents[]")	controller
DELETE	/api/v1/stock/movements/:id/documents/:docId	authenticateToken	controller
GET	/api/v1/stock/movements/:id/documents/:docId/file	authenticateToken	controller
POST	/api/v1/stock/movements/:id/post	authenticateToken	controller
GET	/api/v1/tarification/clients	-	controller
POST	/api/v1/tarification/clients	-	controller
DELETE	/api/v1/tarification/clients/:id	-	controller
GET	/api/v1/tarification/clients/:id	-	controller
PATCH	/api/v1/tarification/clients/:id	-	controller
GET	/api/v1/traceability/chain	authenticateToken	controller
```

## E) Database Schema Overview

### Access Pattern

- `src/config/database.ts` exports a shared `pg.Pool` configured via `DATABASE_URL`.
- Repositories use raw SQL; transactions are manual (`pool.connect()` -> `BEGIN`/`COMMIT`/`ROLLBACK`) as needed.

### Schema Source of Truth

- Many newer domains rely on idempotent SQL patch files under `db/patches/`.
- Several core/legacy tables are referenced by repositories but not created in patches (clients/devis/facturation/outils, etc.).

### Patch Inventory (what each patch creates)

- `db/patches/00001_production_pieces_techniques_gammes.sql`: `public.pieces_techniques`, `public.pieces_techniques_nomenclature`, `public.pieces_techniques_operations`, `public.pieces_techniques_achats`, `public.pieces_techniques_historique`, `public.pieces_techniques_documents`, `public.affaire_pieces_techniques`
- `db/patches/2026-02-12_production_of_machines_postes.sql`: `public.machines`, `public.postes`, `public.ordres_fabrication`, `public.of_operations`, `public.of_time_logs`, `public.of_quality_logs` + enum types (`public.machine_type`, `public.machine_status`, `public.of_*`)
- `db/patches/20260213_production_pointages.sql`: `public.production_pointages`, `public.production_pointage_events` + enums + trigger `public.tg_set_production_pointage_duration_minutes`
- `db/patches/20260213_qualite_module.sql`: `public.quality_control`, `public.quality_control_points`, `public.quality_action`, `public.non_conformity`, `public.quality_documents`, `public.quality_event_log` + enums + `public.quality_generate_nc_reference`
- `db/patches/20260226_qualite_complete_ncr_capa_stock.sql`: `public.non_conformity_dispositions`
- `db/patches/20260214_planning_module.sql`: `public.planning_events`, `public.planning_event_comments`, `public.planning_event_documents` + enums
- `db/patches/20260216_planning_visuals_programmation.sql`: `public.programmations`
- `db/patches/20260215_stock_module.sql`: `public.articles`, `public.article_documents`, `public.lots`, `public.magasins`, `public.emplacements`, `public.stock_movements`, `public.stock_movement_lines`, `public.stock_movement_documents`, `public.stock_movement_event_log`, `public.stock_ledger`, `public.stock_documents`, `public.stock_balances`
- `db/patches/20260223_stock_movements_apply_on_posted.sql`: function `public.fn_apply_stock_movement`
- `db/patches/20260223_stock_inventory_sessions.sql`: `public.stock_inventory_sessions`, `public.stock_inventory_lines`
- `db/patches/20260223_stock_inventory_sessions_uuid_spine.sql`: adds `public.stock_inventory_session_movements` (and extends inventory sessions)
- `db/patches/20260224_commandes_stock_reservations_event_log.sql`: `public.stock_reservations`, `public.commande_client_event_log`
- `db/patches/20260213_livraisons_module.sql`: `public.bon_livraison`, `public.bon_livraison_ligne`, `public.bon_livraison_documents`, `public.bon_livraison_event_log`
- `db/patches/20260223_livraisons_allocations_stock_settings.sql`: `public.bon_livraison_ligne_allocations`, `public.erp_settings`
- `db/patches/20260224_livraisons_pack_versions.sql`: `public.bon_livraison_pack_versions`
- `db/patches/20260225_fournisseurs_catalogue.sql`: `public.fournisseurs`, `public.fournisseur_contacts`, `public.fournisseur_catalogue`, `public.fournisseur_documents`
- `db/patches/20260226_receptions_incoming_quality.sql`: `public.receptions_fournisseurs`, `public.reception_fournisseur_lignes`, `public.reception_fournisseur_documents`, `public.reception_incoming_inspections`, `public.reception_incoming_measurements`, `public.reception_fournisseur_stock_receipts`
- `db/patches/20260227_metrologie_calibration.sql`: `public.metrologie_equipements`, `public.metrologie_plan`, `public.metrologie_certificats`, `public.metrologie_event_log` (and extends `public.erp_settings`)
- `db/patches/20260226_entity_locks.sql`: `public.entity_locks`
- `db/patches/20260226_phase14_quick_commande.sql`: `public.quick_commande_previews`, `public.quick_commande_confirmations`
- `db/patches/20260228_traceability_links.sql`: `public.traceability_links`
- `db/patches/20260228_asbuilt_pack.sql`: `public.asbuilt_pack_versions`
- `db/patches/20260227_nomenclature_codes.sql`: `public.code_sequences` + `public.fn_next_code_value` + `public.quality_generate_action_reference`
- `db/patches/20260216_admin_password_reset_tokens.sql`: `public.password_reset_tokens`
- `db/patches/20260218_password_resets.sql`: `public.password_resets`
- `db/patches/20260224_operation_dossiers_versioning.sql`: `public.operation_dossiers`, `public.operation_dossier_versions`, `public.operation_dossier_version_documents`

### Relationships (high-level)

Foreign keys are defined extensively in patches (hundreds). Examples of central relationships:

- Pieces techniques BOM: `public.pieces_techniques_nomenclature` -> `public.pieces_techniques` (parent/child)
- Pieces techniques operations: `public.pieces_techniques_operations` -> `public.pieces_techniques` (+ optional `public.centres_frais`)
- Affaire linkage: `public.affaire_pieces_techniques` -> `public.affaire` and `public.pieces_techniques`
- Stock: movements/lines link `public.stock_movements` <-> `public.stock_movement_lines` and reference `public.articles`, `public.magasins`, `public.emplacements`, `public.lots`
- Livraisons: `public.bon_livraison_ligne` -> `public.bon_livraison`; allocations reference `public.lots` and stock movement lines
- Receptions: inspections/measurements link from reception lines; stock receipts link to stock movements
- Quality: `public.non_conformity` can reference supplier/reception/OF/BL contexts

## F) Auth/RBAC Description

### HTTP (Express)

- JWT middleware: `src/module/auth/middlewares/auth.middleware.ts`
  - `authenticateToken`: verifies `Authorization: Bearer <token>` using `JWT_SECRET`, populates `req.user`
  - `authorizeRole(...roles)`: exact role allow-list

### RBAC patterns

- Exact role allow-list: `authorizeRole('Administrateur Systeme et Reseau', 'Directeur')` (e.g. `src/module/admin/routes/admin.routes.ts`, `src/module/auth/routes/auth.routes.ts`)
- Inline role contains checks:
  - `requireAdmin` in `src/module/production/routes/production.routes.ts` and `src/module/pieces-techniques/routes/pieces-techniques.routes.ts`
  - `requireProductionOrAdmin` in `src/module/production/routes/production.routes.ts`, `src/module/planning/routes/planning.routes.ts`, `src/module/programmation/routes/programmation.routes.ts`, `src/module/quick-commande/routes/quick-commande.routes.ts`
  - `requireQualityOrAdmin` in `src/module/qualite/routes/qualite.routes.ts`

### Socket.IO

- Socket server: `src/sockets/sockeServer.ts`
  - JWT verification for the handshake (token from `socket.handshake.auth.token` or `Authorization` header)
  - Room model: global `erp:global`, module rooms `module:<key>`, entity rooms `<EntityType>:<EntityId>`
- DB -> realtime bridge: Postgres `LISTEN` + `pg_notify` for audit events
  - Listener: `src/shared/realtime/audit-notify.listener.ts`
  - Notify on insert: `src/module/audit-logs/repository/audit-logs.repository.ts` (`pg_notify('erp_audit_new', ...)`)

## G) Important Files Index

### Core runtime

- `src/index.ts` (HTTP + Socket.IO init + audit listener)
- `src/config/app.ts` (Express stack + `/api/v1` mount + `/docs` + `/images` + error handlers)
- `src/routes/v1.routes.ts` (module mounting)
- `src/config/database.ts` (pg Pool)

### Middlewares

- `src/middlewares/requestId.ts` (`X-Request-Id` propagation)
- `src/middlewares/requestLogger.ts` (structured request logs)
- `src/middlewares/upload.ts` (multer disk storage for images)
- `src/middlewares/validate.ts` (generic Zod body validator helper; not the dominant pattern)
- `src/middlewares/errorHandler.ts` (final error handler)
- `src/middlewares/error.middleware.ts` (ApiError handler; not wired in `src/config/app.ts`)

### Auth

- `src/module/auth/middlewares/auth.middleware.ts` (JWT + role authorization)
- `src/module/auth/middlewares/validationError.middleware.ts` (ZodError -> 400)
- `src/module/auth/services/auth.service.ts` (JWT issuance + password reset transaction)
- `src/module/auth/services/password-reset-email.service.ts` (Resend email integration)

### Docs

- `src/swagger/swagger.ts` (OpenAPI spec served at `/docs`)
- `docs/http/devis.http` (curl examples)
- `docs/nomenclature-codes.md` (code formats + generator notes)

### Database patches

- `db/patches/` (idempotent schema patches)

### Scripts

- `scripts/seed-erp-demo.js` (starts built app on ephemeral port and seeds via REST API)
- `scripts/*smoke*.js` and `scripts/*verification*.sql` (smoke checks)

### Deployment

- `Dockerfile` (build TS -> runtime image; healthcheck)
- `.github/workflows/deploy.yml` (SSH deploy)
- `.cz.toml` (commit message schema)
