import type { WorkPackageDef } from "../types";

/**
 * EPIC-00 → EPIC-07 : cadrage, socle, auth, commerce, données techniques,
 * production, stock, livraisons. Dates réalisées = Git/PR ; futures = prévisionnel.
 * Sources : git log des 2 repos, PRs GitHub (BigFootLime/crp-systems-web,
 * BigFootLime/erp-crp-backend), docs repo. Marquages : VALIDÉ (preuve forte),
 * À VALIDER (date/périmètre incertain), À PLANIFIER (futur non engagé).
 */
export const WP_CORE: WorkPackageDef[] = [
  // ================================================================ EPIC-00
  {
    code: "EPIC-00", title: "Cadrage initial et analyse du besoin", type: "EPIC",
    status: "DONE", priority: "HIGH", start: "2025-06-15", due: "2025-07-31", progress: 100,
    description:
      "Analyse du contexte Croix Rousse Précision (usinage de précision), des limites de CLIPPER 07 et des besoins métier ; décision de construire un ERP sur mesure. Sources : DOC_SOURCE « Analyse du contexte et des besoins.docx », rapport de projet §1-§2, docs/rapport/02_cadrage_du_projet.md. Dates antérieures au premier commit : À VALIDER (pas de preuve Git).",
  },
  {
    code: "LOT-00.1", parent: "EPIC-00", title: "Analyse du contexte entreprise et des limites CLIPPER 07", type: "LOT",
    status: "DONE", priority: "HIGH", start: "2025-06-15", due: "2025-07-15", progress: 100,
    description: "Étude de l'existant : CLIPPER 07 vieillissant, saisies redondantes, traçabilité difficile, dépendance éditeur. Recueil des irritants par service (gestion, production, qualité). Source : DOC_SOURCE « Analyse du contexte et des besoins.docx » — VALIDÉ. Dates : À VALIDER.",
  },
  {
    code: "TSK-00.1.1", parent: "LOT-00.1", title: "Recenser les utilisateurs cibles et services concernés", type: "TASK",
    status: "DONE", start: "2025-06-15", due: "2025-07-15", progress: 100,
    description: "Production, gestion/administration, qualité, direction ; profils opérateurs → responsables. Source : DOC_SOURCE analyse du contexte — VALIDÉ.",
  },
  {
    code: "TSK-00.1.2", parent: "LOT-00.1", title: "Analyser les solutions existantes (progiciels vs sur mesure)", type: "TASK",
    status: "DONE", start: "2025-06-20", due: "2025-07-15", progress: 100,
    description: "Comparaison progiciel du marché / GitLab Premium / développement interne ; choix du sur mesure pour la maîtrise et le coût. Source : rapport de projet §1.3 — VALIDÉ (analyse), dates À VALIDER.",
  },
  {
    code: "LOT-00.2", parent: "EPIC-00", title: "Cadrage CERP : objectifs, périmètre, parties prenantes", type: "LOT",
    status: "DONE", priority: "HIGH", start: "2025-07-01", due: "2025-07-31", progress: 100,
    description: "Définition du projet CERP : remplacer progressivement CLIPPER 07, centraliser les flux, traçabilité, interface moderne, maîtrise interne. Périmètre progressif par modules. Sources : docs/rapport/02_cadrage_du_projet.md, rapport §2 — VALIDÉ.",
  },

  // ================================================================ EPIC-01
  {
    code: "EPIC-01", title: "Socle technique et architecture", type: "EPIC",
    status: "DONE", priority: "HIGH", start: "2025-07-15", due: "2026-07-03", progress: 100,
    description:
      "Mise en place des deux repos, du socle Express/TypeScript et React/Vite/TypeScript, de la CI/CD, de la conteneurisation, de l'architecture modulaire documentée (ADR) et du client desktop Electron. Sources : GIT_COMMIT c6fd108 (2025-07-15), GIT_COMMIT a892af7 (2025-07-18), ADR 0001→0012 — VALIDÉ.",
  },
  {
    code: "LOT-01.1", parent: "EPIC-01", title: "Bootstrap backend Express/TypeScript (ossature API)", type: "LOT",
    status: "DONE", start: "2025-07-15", due: "2025-07-31", progress: 100,
    description: "Initialisation erp-crp-backend : Express, structure routes/controllers/services/repository, commitizen. Source : GIT_COMMIT c6fd108→0c29737 (2025-07-15) — VALIDÉ.",
  },
  {
    code: "LOT-01.2", parent: "EPIC-01", title: "Bootstrap frontend React/Vite/TypeScript + UI kit", type: "LOT",
    status: "DONE", start: "2025-07-18", due: "2025-07-31", progress: 100,
    description: "Initialisation crp-systems-web : Vite, React, TypeScript, composants UI (shadcn : table, tabs, sonner…), routing. Source : GIT_COMMIT a892af7→5a7cbd0 (2025-07-18) — VALIDÉ.",
  },
  {
    code: "LOT-01.3", parent: "EPIC-01", title: "CI/CD initiale GitHub Actions + déploiement SCP", type: "INFRA",
    status: "DONE", start: "2025-07-20", due: "2025-08-31", progress: 100,
    description: "Workflows ci.yml/deploy.yml, déploiement SCP vers le serveur. Source : GIT_COMMIT (2025-07/08, messages CI/CD) — VALIDÉ.",
  },
  {
    code: "LOT-01.4", parent: "EPIC-01", title: "Conteneurisation Docker + reverse proxy Nginx", type: "INFRA",
    status: "DONE", start: "2025-10-01", due: "2025-10-31", progress: 100,
    description: "Dockerfiles, Nginx, préparation hébergement. Source : GIT_COMMIT 2025-10 (front) — VALIDÉ. Complété par le fix permissions storage conteneur (GITHUB_PR erp-crp-backend#21, 2026-06-23).",
  },
  {
    code: "LOT-01.5", parent: "EPIC-01", title: "Architecture modulaire documentée (ADR 0001-0011, blueprint)", type: "DOC",
    status: "DONE", start: "2026-06-16", due: "2026-06-16", progress: 100,
    description: "Monolithe modulaire, docs-as-code, PostgreSQL, RBAC/audit, outbox, Coolify, GitHub Actions. Source : DOC_SOURCE docs/adr/0001→0011 (2026-06-16) — VALIDÉ.",
  },
  {
    code: "LOT-01.6", parent: "EPIC-01", title: "CERP Desktop : shell Electron local-first + auto-update", type: "LOT",
    status: "DONE", start: "2026-06-23", due: "2026-07-03", progress: 100,
    description: "Client desktop Electron (sélection API WireGuard→HYPERBOX2, stockage local, contrôle des mises à jour, flux public update feed). Sources : GITHUB_PR crp-systems-web#45, #48 (2026-06-23), erp-crp-backend#16, ADR 0012 update feed (2026-07-03) — VALIDÉ.",
  },

  // ================================================================ EPIC-02
  {
    code: "EPIC-02", title: "Authentification, utilisateurs, RBAC et audit", type: "EPIC",
    status: "IN_PROGRESS", priority: "CRITICAL", start: "2025-07-15", due: "2026-09-30", progress: 85,
    description:
      "Authentification JWT, gestion des utilisateurs et rôles, sélection base prod/test au login, durcissement sécurité (default-deny, rate-limit, erreurs génériques), audit logs append-only. Reste : RBAC granulaire complet par module. Sources : git log 2025-07 (auth), GITHUB_PR #28/#29/#51/#53/#61 backend — VALIDÉ.",
  },
  {
    code: "LOT-02.1", parent: "EPIC-02", title: "Authentification JWT + écran de login", type: "LOT",
    status: "DONE", start: "2025-07-15", due: "2025-08-15", progress: 100,
    description: "Login JWT (bcrypt), middleware authenticateToken, écran login. Source : GIT_COMMIT 2025-07 (auth bootstrap) — VALIDÉ.",
  },
  {
    code: "LOT-02.2", parent: "EPIC-02", title: "Gestion utilisateurs, rôles applicatifs, auth centralisée", type: "LOT",
    status: "DONE", start: "2025-07-15", due: "2026-01-31", progress: 100,
    description: "CRUD utilisateurs (rôles Directeur/Employee/Responsable…), restructuration auth centralisée (2026-01), routes admin. Source : GIT_COMMIT 2026-01 — VALIDÉ.",
  },
  {
    code: "LOT-02.3", parent: "EPIC-02", title: "Sélecteur de base prod/test au login (X-CERP-Database)", type: "FEATURE",
    status: "DONE", start: "2026-06-22", due: "2026-06-23", progress: 100,
    description: "Choix cerp_prod/cerp_test au login, header applicatif X-CERP-Database, fix CORS. Sources : GITHUB_PR erp-crp-backend#18/#19, issue #17, crp-systems-web issue #50 — VALIDÉ.",
  },
  {
    code: "LOT-02.4", parent: "EPIC-02", title: "Durcissement sécurité authentification (vague CA-SEC)", type: "SECURITY",
    status: "DONE", start: "2026-07-06", due: "2026-07-09", progress: 100,
    description: "Socle default-deny sur /api/v1, rate-limit login anti-bruteforce, blocage de l'escalade de privilèges via /auth/register public, erreurs 500 génériques. Sources : GITHUB_PR erp-crp-backend#29 (CA-SEC-01), #51 (CA-SEC-02), #28, #61 (CA-SEC-04) — VALIDÉ.",
  },
  {
    code: "TSK-02.4.1", parent: "LOT-02.4", title: "CA-SEC-01 — default-deny auth sur /api/v1", type: "SECURITY",
    status: "DONE", start: "2026-07-06", due: "2026-07-07", progress: 100,
    description: "Toute route non explicitement publique exige un JWT. Source : GITHUB_PR erp-crp-backend#29 — VALIDÉ.",
  },
  {
    code: "TSK-02.4.2", parent: "LOT-02.4", title: "CA-SEC-02 — rate-limit login anti-bruteforce", type: "SECURITY",
    status: "DONE", start: "2026-07-07", due: "2026-07-07", progress: 100,
    description: "Limitation de débit sur /auth/login. Source : GITHUB_PR erp-crp-backend#51 — VALIDÉ.",
  },
  {
    code: "TSK-02.4.3", parent: "LOT-02.4", title: "Fix escalade de privilèges via /auth/register public", type: "SECURITY",
    status: "DONE", start: "2026-07-06", due: "2026-07-07", progress: 100,
    description: "Le register public ne peut plus créer de comptes privilégiés. Source : GITHUB_PR erp-crp-backend#28 — VALIDÉ.",
  },
  {
    code: "TSK-02.4.4", parent: "LOT-02.4", title: "CA-SEC-04 — erreurs 500 génériques (pas de fuite d'internes)", type: "SECURITY",
    status: "DONE", start: "2026-07-09", due: "2026-07-09", progress: 100,
    description: "Réponses d'erreur normalisées sans stack/SQL. Sources : GITHUB_PR erp-crp-backend#61, docs/ai/ca-sec-04-release-report.md — VALIDÉ.",
  },
  {
    code: "LOT-02.5", parent: "EPIC-02", title: "Audit logs append-only (erp_audit_logs, ISO A.8.15)", type: "SECURITY",
    status: "DONE", start: "2026-07-07", due: "2026-07-07", progress: 100,
    description: "Journal d'audit inviolable (append-only), appliqué en prod. Sources : GITHUB_PR erp-crp-backend#53, crp-systems-web#105/#107 (CA-SEC-03), preuve compliance/iso27001/evidence/CA-SEC-03_erp_audit_logs_append_only.md — VALIDÉ.",
  },
  {
    code: "LOT-02.6", parent: "EPIC-02", title: "RBAC granulaire par module (cible)", type: "SECURITY",
    status: "IN_PROGRESS", priority: "HIGH", start: "2026-07-10", due: "2026-09-30", progress: 30,
    description: "Généraliser le contrôle d'accès par rôle/module (au-delà des gardes actuelles auth + feature flags). Source : DOC_SOURCE docs/security/rbac.md (2026-07-10), risque « RBAC insuffisant » — BROUILLON_IA, périmètre À VALIDER.",
  },
  {
    code: "LOT-02.7", parent: "EPIC-02", title: "Exposition minimale des utilisateurs (users_view, CA-RGPD-07)", type: "COMPLIANCE",
    status: "DONE", start: "2026-07-07", due: "2026-07-07", progress: 100,
    description: "Vue users_view minimisée (pas de données RH sensibles côté API générique), appliquée en prod. Sources : GITHUB_PR erp-crp-backend#55, crp-systems-web#109/#110 — VALIDÉ.",
  },

  // ================================================================ EPIC-03
  {
    code: "EPIC-03", title: "Commerce : clients, devis, commandes, affaires, facturation", type: "EPIC",
    status: "IN_PROGRESS", priority: "HIGH", start: "2025-09-01", due: "2026-12-18", progress: 80,
    description:
      "Chaîne commerciale complète : clients (contacts, adresses, codes), devis (totaux serveur, statuts, conversion), commandes 3 types (FERME/CADRE/INTERNE, AR, affaires, allocations), facturation (factures, avoirs, paiements, PDF). Sources : git log 2025-09→2026-02 (pic février), PRs CA-APP-01/02, A1-A6 — VALIDÉ pour le réalisé ; compléments facturation À PLANIFIER.",
  },
  {
    code: "LOT-03.1", parent: "EPIC-03", title: "Clients : fiche, contacts, adresses, code client", type: "LOT",
    status: "DONE", start: "2025-09-01", due: "2026-07-07", progress: 100,
    description: "Création/modification clients, contacts (POST contact), payment modes, quality levels, analytics, logo, auto-format code postal, PATCH partiel réel. Sources : GIT_COMMIT 2025-09→10, GITHUB_PR erp-crp-backend#27/#35, crp-systems-web#87 (A2) — VALIDÉ.",
  },
  {
    code: "LOT-03.2", parent: "EPIC-03", title: "Devis : formulaire, totaux serveur, statuts, conversion commande", type: "LOT",
    status: "DONE", start: "2025-09-01", due: "2026-07-07", progress: 100,
    description: "Devis + dashboard, recalcul serveur des totaux (CA-APP-01), enum statut canonique + CHECK DB (CA-APP-02), remises (A3), conversion en commande (fix ids SQL). Sources : GITHUB_PR erp-crp-backend#31/#33/#14, crp-systems-web#62/#89 — VALIDÉ.",
  },
  {
    code: "LOT-03.3", parent: "EPIC-03", title: "Commandes : 3 types FERME/CADRE/INTERNE, AR, allocations", type: "LOT",
    status: "DONE", start: "2026-01-15", due: "2026-07-07", progress: 100,
    description: "Création directe des trois types de commande (ferme = fermée, cadre = ouverte avec appels de livraison, interne), badges/résumé UI (A1), déblocage projet. Sources : GITHUB_PR crp-systems-web#59/#85, git log 2026-02 — VALIDÉ.",
  },
  {
    code: "LOT-03.4", parent: "EPIC-03", title: "Affaires : livraison | projet, onboarding", type: "LOT",
    status: "IN_PROGRESS", start: "2026-02-01", due: "2026-10-30", progress: 70,
    description: "Affaires typées livraison|projet (migration 20260706), articles fabriqués rattachés à une affaire projet, centre d'onboarding affaire (issue #37 ouverte). Sources : GITHUB_PR erp-crp-backend#27, crp-systems-web issue #37 — VALIDÉ pour le réalisé.",
  },
  {
    code: "LOT-03.5", parent: "EPIC-03", title: "Facturation : factures, avoirs, paiements, PDF", type: "LOT",
    status: "IN_PROGRESS", start: "2025-09-15", due: "2026-12-18", progress: 60,
    description: "Module facturation (2025-09 début, cœur 2026-02) : factures et documents ; avoirs/paiements/PDF complets à finaliser. Source : git log 2025-09/2026-02 (module facturation, biller) — réalisé VALIDÉ, reste À PLANIFIER (2026-T4).",
  },

  // ================================================================ EPIC-04
  {
    code: "EPIC-04", title: "Données techniques : articles, pièces, nomenclatures, gammes", type: "EPIC",
    status: "IN_PROGRESS", priority: "HIGH", start: "2025-11-01", due: "2026-10-30", progress: 75,
    description:
      "Référentiel technique : articles (codification, familles), pièces techniques (versions/indices, plan_reference), nomenclatures fabrication vs achat, gammes et opérations, documents techniques. GPAO/PDM V2 livrée le 2026-07-09 (B7). Sources : git log 2025-11→12, GITHUB_PR #57/#59/#60/#112/#115 — VALIDÉ.",
  },
  {
    code: "LOT-04.1", parent: "EPIC-04", title: "Pièces techniques v1 : fiche et création", type: "LOT",
    status: "DONE", start: "2025-11-01", due: "2025-12-31", progress: 100,
    description: "Première version du module pièces techniques (création, fiche). Source : GIT_COMMIT 2025-11/12 — VALIDÉ.",
  },
  {
    code: "LOT-04.2", parent: "EPIC-04", title: "Articles : codification, familles, catégories, aide fabriqué→projet", type: "LOT",
    status: "IN_PROGRESS", start: "2026-01-15", due: "2026-10-30", progress: 75,
    description: "Base articles + familles pièces, aide « article fabriqué → affaire projet » (A4). Plan de codification et traçabilité à intégrer au référentiel. Sources : GITHUB_PR crp-systems-web#91, DOC_SOURCE CERP_Plan_Codification_Articles_Tracabilite.xlsx, docs/nomenclature-codes.md — réalisé VALIDÉ, codification À_COMPLÉTER.",
  },
  {
    code: "LOT-04.3", parent: "EPIC-04", title: "GPAO P1/P2 : audits B1/B5, modèle cible, versions/gammes/nomenclature", type: "LOT",
    status: "DONE", start: "2026-07-06", due: "2026-07-07", progress: 100,
    description: "Audits pièces techniques (B1, B5 lien article), ADR modèle cible GPAO, backend versions/gammes/opérations/nomenclature (P2). Sources : GITHUB_PR crp-systems-web#112, erp-crp-backend#57, docs/architecture/pieces-techniques-* — VALIDÉ.",
  },
  {
    code: "LOT-04.4", parent: "EPIC-04", title: "PDM V2 : versions/indices, achats typés, lien article↔pièce, UI", type: "LOT",
    status: "DONE", start: "2026-07-08", due: "2026-07-09", progress: 100,
    description: "Cœur PDM (versions/indices de pièces, achats typés, lien article), UI Données techniques (versions, arborescence, achats, gammes). Sources : GITHUB_PR erp-crp-backend#59/#60, crp-systems-web#115, docs/ai/B7-release-report.md — VALIDÉ.",
  },
  {
    code: "LOT-04.5", parent: "EPIC-04", title: "Nomenclatures : arborescence de fabrication récursive vs nomenclature achat", type: "LOT",
    status: "DONE", start: "2026-06-23", due: "2026-06-24", progress: 100,
    description: "Arbres de fabrication OF récursifs, séparation nomenclature fabrication / achat. Sources : GITHUB_PR erp-crp-backend#23, crp-systems-web#56, issue #55, ADR-0012 (snapshots OF) — VALIDÉ.",
  },
  {
    code: "LOT-04.6", parent: "EPIC-04", title: "Documents techniques : plans, indices, contrôles", type: "LOT",
    status: "IN_PROGRESS", start: "2026-02-01", due: "2026-11-27", progress: 50,
    description: "Dossiers d'opération (operation-dossiers) et rattachement documents/plans avec indices ; généralisation GED technique à venir. Sources : git log 2026-02, note du 25/06 (documents qualité, plans) — réalisé VALIDÉ, cible À PLANIFIER.",
  },

  // ================================================================ EPIC-05
  {
    code: "EPIC-05", title: "Production / GPAO : OF, opérations, planning, machines", type: "EPIC",
    status: "IN_PROGRESS", priority: "HIGH", start: "2026-02-01", due: "2027-06-30", progress: 70,
    description:
      "OF parent/enfant avec snapshot de structure, opérations et gammes (tournage/fraisage/reprise), machines/postes, planning atelier, retard réel, sous-traitance, vision OF machine (MES). Sources : git log 2026-02 (planning, production), GITHUB_PR #23/#56, docs B6/B7 — VALIDÉ pour le réalisé.",
  },
  {
    code: "LOT-05.1", parent: "EPIC-05", title: "OF parent/enfant + snapshot de structure", type: "LOT",
    status: "DONE", start: "2026-06-23", due: "2026-07-09", progress: 100,
    description: "Génération récursive des arbres d'OF, snapshot de la structure à la création (ADR-0012), référence article + indice sur OF. Sources : GITHUB_PR erp-crp-backend#23, ADR-0012, B6/B7 — VALIDÉ.",
  },
  {
    code: "LOT-05.2", parent: "EPIC-05", title: "Opérations et gammes : tournage / fraisage / reprise", type: "LOT",
    status: "DONE", start: "2026-02-01", due: "2026-07-09", progress: 100,
    description: "Gammes avec opérations typées, dossiers d'opération. Sources : git log 2026-02, GITHUB_PR erp-crp-backend#57 (P2), note du 25/06 — VALIDÉ.",
  },
  {
    code: "LOT-05.3", parent: "EPIC-05", title: "Machines et postes de charge", type: "LOT",
    status: "DONE", start: "2026-02-01", due: "2026-02-28", progress: 100,
    description: "Référentiel machines/postes utilisé par le planning atelier. Source : git log 2026-02 (module planning/production) — VALIDÉ.",
  },
  {
    code: "LOT-05.4", parent: "EPIC-05", title: "Planning atelier : vue de charge, redesign, validation AR", type: "LOT",
    status: "IN_PROGRESS", start: "2026-02-01", due: "2026-11-27", progress: 60,
    description: "Planning atelier opérationnel (2026-02) ; redesign board + validation AR (issue #38) et fonction « figer le planning » (note du 25/06) restants. Sources : git log 2026-02, crp-systems-web issue #38 — réalisé VALIDÉ, reste À PLANIFIER.",
  },
  {
    code: "LOT-05.5", parent: "EPIC-05", title: "Retard réel et replanification", type: "FEATURE",
    status: "BACKLOG", start: "2026-10-01", due: "2026-12-18", progress: 0, assign: false,
    description: "Calcul du retard réel par OF/opération et aide à la replanification. Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2026-T4).",
  },
  {
    code: "LOT-05.6", parent: "EPIC-05", title: "Sous-traitance : vision et suivi des opérations externalisées", type: "FEATURE",
    status: "BACKLOG", start: "2027-01-04", due: "2027-03-31", progress: 0, assign: false,
    description: "Suivi des OF/opérations sous-traités (envois, retours, délais). Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2027-T1).",
  },
  {
    code: "LOT-05.7", parent: "EPIC-05", title: "Vision OF machine / tablette (pré-MES)", type: "FEATURE",
    status: "BACKLOG", start: "2027-04-01", due: "2027-09-30", progress: 0, assign: false,
    description: "Affichage OF au poste (tablette atelier), première brique MES. Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2027-T2/T3), voir EPIC-14.",
  },
  {
    code: "LOT-05.8", parent: "EPIC-05", title: "GPAO V2 : tests métier B6 et release B7", type: "LOT",
    status: "DONE", start: "2026-07-09", due: "2026-07-09", progress: 100,
    description: "Campagne de tests métier bout-en-bout GPAO (B6) et rapport de release (B7). Sources : DOC_SOURCE docs/ai/B6-gpao-business-tests-report.md, docs/ai/B7-release-report.md, docs/ai/atelier-gpao-v2-state.md — VALIDÉ.",
  },

  // ================================================================ EPIC-06
  {
    code: "EPIC-06", title: "Stock, outillage, réceptions", type: "EPIC",
    status: "IN_PROGRESS", priority: "NORMAL", start: "2025-07-20", due: "2026-12-18", progress: 65,
    description:
      "Outillage (premier module livré, été 2025), stock articles avec versioning, stock matière, magasins/emplacements/lots/mouvements, réceptions fournisseur avec contrôle. Sources : git log 2025-07/08, 2026-02/03/04 — VALIDÉ pour le réalisé.",
  },
  {
    code: "LOT-06.1", parent: "EPIC-06", title: "Outillage : sorties, panier, inventaire, fiches (fabricants/fournisseurs/outils/revêtements)", type: "LOT",
    status: "DONE", start: "2025-07-20", due: "2026-02-28", progress: 100,
    description: "Premier module métier livré : sorties d'outils, panier, inventaire, fiches de référence, dashboard (2026-02). Source : GIT_COMMIT 2025-07→08, 2026-02 — VALIDÉ.",
  },
  {
    code: "LOT-06.2", parent: "EPIC-06", title: "Stock articles + versioning", type: "LOT",
    status: "DONE", start: "2026-03-01", due: "2026-03-31", progress: 100,
    description: "Stock des articles avec versions. Source : GIT_COMMIT 2026-03 — VALIDÉ.",
  },
  {
    code: "LOT-06.3", parent: "EPIC-06", title: "Stock matière", type: "LOT",
    status: "IN_PROGRESS", start: "2026-04-01", due: "2026-10-30", progress: 40,
    description: "Gestion de la matière première (début 2026-04, interrompu par la pause avril-mai). Source : GIT_COMMIT 2026-04 — réalisé VALIDÉ, reste À PLANIFIER.",
  },
  {
    code: "LOT-06.4", parent: "EPIC-06", title: "Magasins, emplacements, lots, mouvements, inventaire", type: "LOT",
    status: "IN_PROGRESS", start: "2026-03-01", due: "2026-12-18", progress: 45,
    description: "Structure de magasinage et mouvements de stock ; inventaire périodique à outiller. Source : MODULE_ANALYSIS (module stock existant) — À_COMPLÉTER (2026-T4).",
  },
  {
    code: "LOT-06.5", parent: "EPIC-06", title: "Réceptions fournisseur + contrôle réception", type: "LOT",
    status: "DONE", start: "2026-02-01", due: "2026-02-28", progress: 100,
    description: "Réceptions fournisseur (phase 9) avec contrôle à réception ; smoke tests dédiés. Sources : GIT_COMMIT 2026-02, scripts/phase9-receptions-smoke.js + phase9-receptions-sql-verification.sql — VALIDÉ.",
  },
  {
    code: "LOT-06.6", parent: "EPIC-06", title: "Stock avancé : seuils, réappro, valorisation", type: "FEATURE",
    status: "BACKLOG", start: "2026-10-01", due: "2026-12-18", progress: 0, assign: false,
    description: "Seuils mini/maxi, propositions de réapprovisionnement, valorisation. Source : roadmap restante — À PLANIFIER (2026-T4).",
  },

  // ================================================================ EPIC-07
  {
    code: "EPIC-07", title: "Livraisons, expédition, documents", type: "EPIC",
    status: "IN_PROGRESS", priority: "NORMAL", start: "2026-02-01", due: "2026-12-18", progress: 60,
    description:
      "Bons de livraison avec allocations de stock, pack documentaire d'expédition (PDF), données as-built. Facturation rattachée à EPIC-03. Sources : git log 2026-02, scripts/phase6-pack-smoke.js — VALIDÉ pour le réalisé.",
  },
  {
    code: "LOT-07.1", parent: "EPIC-07", title: "Bons de livraison + allocations stock", type: "LOT",
    status: "DONE", start: "2026-02-01", due: "2026-02-28", progress: 100,
    description: "BL rattachés aux commandes avec allocations de stock. Source : GIT_COMMIT 2026-02 (module livraisons) — VALIDÉ.",
  },
  {
    code: "LOT-07.2", parent: "EPIC-07", title: "Pack documentaire d'expédition + PDF", type: "LOT",
    status: "IN_PROGRESS", start: "2026-02-01", due: "2026-10-30", progress: 70,
    description: "Pack de documents à l'expédition (phase 6, smoke test dédié) ; compléments PDF/gabarits à finaliser. Sources : scripts/phase6-pack-smoke.js — réalisé VALIDÉ, reste À PLANIFIER.",
  },
  {
    code: "LOT-07.3", parent: "EPIC-07", title: "As-built et données de livraison qualité", type: "LOT",
    status: "IN_PROGRESS", start: "2026-02-01", due: "2026-11-27", progress: 50,
    description: "Données as-built liées aux livraisons (module asbuilt). Source : MODULE_ANALYSIS (modules asbuilt front+back) — À_COMPLÉTER.",
  },
  {
    code: "TSK-07.4", parent: "EPIC-07", title: "Livraison Intelligence Hub (refonte pilotage livraisons)", type: "FEATURE",
    status: "BACKLOG", start: "2026-11-02", due: "2026-12-18", progress: 0, assign: false,
    description: "Refonte du pilotage des livraisons. Source : GITHUB_PR crp-systems-web issue #36 (ouverte) — À PLANIFIER.",
  },
];
