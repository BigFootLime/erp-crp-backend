import type { WorkPackageDef } from "../types";

/**
 * EPIC-08 → EPIC-14 : qualité, sécurité/conformité, Temps & Déplacements,
 * Project Office, tests/déploiement, formation/bilan, roadmap future.
 */
export const WP_TRANSVERSE: WorkPackageDef[] = [
  // ================================================================ EPIC-08
  {
    code: "EPIC-08", title: "Qualité, traçabilité, métrologie", type: "EPIC",
    status: "IN_PROGRESS", priority: "HIGH", start: "2026-02-01", due: "2027-03-31", progress: 60,
    description:
      "Contrôles et dispositions qualité, non-conformités et CAPA, traçabilité (lots, rebut), métrologie et moyens de mesure, documents qualité, KPI. Sources : git log 2026-02 (qualité, métrologie, traçabilité) — VALIDÉ pour le réalisé ; documents qualité et KPI maintenance À PLANIFIER.",
  },
  {
    code: "LOT-08.1", parent: "EPIC-08", title: "Qualité : contrôles, dispositions, KPI, lots", type: "LOT",
    status: "DONE", start: "2026-02-01", due: "2026-02-28", progress: 100,
    description: "Module qualité : dispositions, KPI, gestion par lots. Source : GIT_COMMIT 2026-02 — VALIDÉ.",
  },
  {
    code: "LOT-08.2", parent: "EPIC-08", title: "Non-conformités et registre CAPA", type: "LOT",
    status: "IN_PROGRESS", start: "2026-07-07", due: "2026-12-18", progress: 55,
    description: "Registre d'actions correctives/préventives tenu en docs-as-code, à outiller dans l'ERP. Sources : DOC_SOURCE compliance/iso27001/12_corrective_actions_register.md, 13_post_b7_gpao_v2_compliance_review.md — réalisé VALIDÉ, outillage À PLANIFIER.",
  },
  {
    code: "LOT-08.3", parent: "EPIC-08", title: "Métrologie et moyens de mesure", type: "LOT",
    status: "IN_PROGRESS", start: "2026-02-01", due: "2026-12-18", progress: 50,
    description: "Module métrologie (2026-02) ; gestion complète des moyens de mesure (étalonnage, échéances) à compléter. Sources : GIT_COMMIT 2026-02, note du 25/06 — réalisé VALIDÉ, reste À PLANIFIER (2026-T4).",
  },
  {
    code: "LOT-08.4", parent: "EPIC-08", title: "Traçabilité : lots, rebut, généalogie", type: "LOT",
    status: "DONE", start: "2026-02-01", due: "2026-02-28", progress: 100,
    description: "Module traçabilité (généalogie des lots). Source : GIT_COMMIT 2026-02 (module traceability) — VALIDÉ.",
  },
  {
    code: "LOT-08.5", parent: "EPIC-08", title: "Documents qualité liés aux OF/livraisons", type: "FEATURE",
    status: "BACKLOG", start: "2026-10-01", due: "2026-12-18", progress: 0, assign: false,
    description: "Rattachement systématique des documents qualité (PV contrôle, certificats) aux OF et livraisons. Source : DOC_SOURCE note du 25/06 — À PLANIFIER.",
  },
  {
    code: "LOT-08.6", parent: "EPIC-08", title: "KPI maintenance machines", type: "FEATURE",
    status: "BACKLOG", start: "2027-01-04", due: "2027-03-31", progress: 0, assign: false,
    description: "Indicateurs de maintenance des machines (pannes, disponibilité). Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2027-T1).",
  },

  // ================================================================ EPIC-09
  {
    code: "EPIC-09", title: "Sécurité, conformité ISO 27001 / RGPD / Air Cyber", type: "EPIC",
    status: "IN_PROGRESS", priority: "CRITICAL", start: "2026-06-16", due: "2027-09-30", progress: 70,
    description:
      "SMSI ISO 27001 (périmètre, SoA, registre risques, CAPA), RGPD (minimisation, registre), réponse Air Cyber, gestion des dépendances (SCA), sauvegardes/PRA, secrets. Vague sécurité livrée 2026-07-06→09. Sources : GITHUB_PR crp-systems-web#60, compliance/iso27001/*, docs/security/* — VALIDÉ pour le réalisé ; certification non visée à ce stade.",
  },
  {
    code: "LOT-09.1", parent: "EPIC-09", title: "SMSI ISO 27001 : périmètre, SoA, registre des risques", type: "COMPLIANCE",
    status: "IN_PROGRESS", start: "2026-07-06", due: "2027-03-31", progress: 60,
    description: "Fondation SMSI : 00_scope, 01_context, 03_risk_register, 05_SoA update, preuves. Sources : GITHUB_PR crp-systems-web#60, DOC_SOURCE compliance/iso27001/, docs/security/iso27001-evidence/ (dont statement-of-applicability.md), Grille audit ISO 27001.xlsx — VALIDÉ pour l'existant ; sections 02/04/06-11 À_COMPLÉTER.",
  },
  {
    code: "LOT-09.2", parent: "EPIC-09", title: "Registre CAPA sécurité et revues de conformité", type: "COMPLIANCE",
    status: "IN_PROGRESS", start: "2026-07-07", due: "2026-12-18", progress: 65,
    description: "Registre d'actions correctives (CA-SEC/CA-RGPD/CA-DEV/CA-APP) et revues post-release. Sources : DOC_SOURCE compliance/iso27001/12_corrective_actions_register.md, 13_post_b7 — VALIDÉ.",
  },
  {
    code: "LOT-09.3", parent: "EPIC-09", title: "RGPD : minimisation, registre des traitements, droits", type: "COMPLIANCE",
    status: "IN_PROGRESS", start: "2026-06-16", due: "2027-06-30", progress: 45,
    description: "users_view minimisée (CA-RGPD-07 appliqué prod), gabarits docs/gdpr (registre, droits, rétention) à compléter pour le module RH (données pointage). Sources : GITHUB_PR #55/#109/#110, DOC_SOURCE docs/gdpr/ — réalisé VALIDÉ, registre À_COMPLÉTER.",
  },
  {
    code: "LOT-09.4", parent: "EPIC-09", title: "Air Cyber : grille d'exigences et plan de réponse", type: "COMPLIANCE",
    status: "IN_PROGRESS", start: "2026-07-06", due: "2027-03-31", progress: 40,
    description: "Réponse aux exigences cyber aéronautiques clients. Sources : DOC_SOURCE Air Cyber.xlsx, docs/security/iso27001-evidence/air-cyber-response.md — VALIDÉ pour l'analyse, plan d'actions À_COMPLÉTER.",
  },
  {
    code: "LOT-09.5", parent: "EPIC-09", title: "Dépendances : SCA Dependabot + traitement de la dette", type: "SECURITY",
    status: "IN_PROGRESS", start: "2026-07-07", due: "2026-09-30", progress: 50,
    description: "SCA activée sur les 2 repos + overrides (P1.5), fix vulnérabilité critique vitest, fix ws High (CA-DEV-04). Reste ~40 PRs Dependabot ouvertes à trier. Sources : GITHUB_PR erp-crp-backend#36, crp-systems-web#68/#117 — VALIDÉ ; tri À PLANIFIER.",
  },
  {
    code: "LOT-09.6", parent: "EPIC-09", title: "Sauvegardes, restauration et durcissement VPS", type: "INFRA",
    status: "IN_PROGRESS", start: "2026-07-06", due: "2026-09-30", progress: 70,
    description: "Backups PostgreSQL testés (cerp-pg-backup.sh), durcissement VPS, incident connectivité WireGuard résolu (2026-07-06). Procédure backup/restore à documenter formellement. Sources : DOC_SOURCE docs/security/change-records/2026-07-06-backups-and-vps-hardening.md, docs/devops/cerp-connectivity-incident-2026-07-06.md, docs/devops/hyperbox2-postgres-runbook.md — VALIDÉ ; procédure À_COMPLÉTER.",
  },
  {
    code: "LOT-09.7", parent: "EPIC-09", title: "Gestion des secrets et environnements", type: "SECURITY",
    status: "IN_PROGRESS", start: "2026-07-06", due: "2026-10-30", progress: 40,
    description: "Secrets hors repo (.env, Coolify), rotation à cadrer ; incident de dérive .env/Coolify du 2026-07-06 documenté. Sources : DOC_SOURCE docs/security/secrets-management.md (squelette), docs/devops/ — À_COMPLÉTER.",
  },
  {
    code: "LOT-09.8", parent: "EPIC-09", title: "Audit interne de conformité (préparation)", type: "AUDIT",
    status: "BACKLOG", start: "2027-01-04", due: "2027-03-31", progress: 0, assign: false,
    description: "Audit interne ISO 27001 / revue Air Cyber sur le périmètre CERP. Source : macro-planning — À PLANIFIER (jalon J13).",
  },

  // ================================================================ EPIC-10
  {
    code: "EPIC-10", title: "Temps & Déplacements (pointage, kilomètres, exports paie)", type: "EPIC",
    status: "REVIEW", priority: "HIGH", start: "2026-07-08", due: "2026-09-30", progress: 95,
    description:
      "Module RH natif : pointage append-only avec calcul 35h/39h, corrections validées, kilomètres, exports paie CSV/PDF figés avec checksum, bornes kiosk HID + badges. T1→T11 livrés et déployés (pilote). Reste : recette RH réelle et badgeuse matérielle. Sources : GITHUB_PR #64→#75 (backend), #120→#129 (frontend), issue #119, ADR-0013 — VALIDÉ.",
  },
  {
    code: "LOT-10.1", parent: "EPIC-10", title: "Cadrage module + ADR-0013", type: "DOC",
    status: "DONE", start: "2026-07-08", due: "2026-07-09", progress: 100,
    description: "Phase 1 cadrage, architecture module, ADR-0013 accepté. Sources : GITHUB_PR crp-systems-web#120, docs/adr/ADR-0013-temps-pointage-kilometres.md — VALIDÉ.",
  },
  {
    code: "LOT-10.2", parent: "EPIC-10", title: "T1/T2 : schéma hr_* append-only + backend pointage", type: "LOT",
    status: "DONE", start: "2026-07-09", due: "2026-07-09", progress: 100,
    description: "Tables hr_* (events append-only), rôle RH, calculs, RBAC. Sources : GITHUB_PR erp-crp-backend#64/#65 — VALIDÉ.",
  },
  {
    code: "LOT-10.3", parent: "EPIC-10", title: "T3/T4 : UI salarié (pointage, relevé, anomalies) + responsable (équipe, corrections)", type: "LOT",
    status: "DONE", start: "2026-07-09", due: "2026-07-09", progress: 100,
    description: "Frontend salarié et responsable + validation RH côté backend. Sources : GITHUB_PR crp-systems-web#121/#122, erp-crp-backend#66 — VALIDÉ.",
  },
  {
    code: "LOT-10.4", parent: "EPIC-10", title: "T5 : administration RH (contrats, horaires, règles 35h/39h)", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Contrats/horaires/règles + calcul réel 35h/39h. Sources : GITHUB_PR erp-crp-backend#68, crp-systems-web#123 — VALIDÉ.",
  },
  {
    code: "LOT-10.5", parent: "EPIC-10", title: "T6 : kilomètres (déclaration salarié + validation équipe)", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Déclaration et validation des kilomètres. Sources : GITHUB_PR erp-crp-backend#70, crp-systems-web#125 — VALIDÉ.",
  },
  {
    code: "LOT-10.6", parent: "EPIC-10", title: "T7 : exports paie CSV/PDF figés + checksum", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Exports figés en base (base64 + checksum vérifié au téléchargement). Sources : GITHUB_PR erp-crp-backend#69, crp-systems-web#124 — VALIDÉ.",
  },
  {
    code: "LOT-10.7", parent: "EPIC-10", title: "T8 : bornes kiosk HID + provisioning badges", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Page borne (kiosk HID) + gestion bornes/badges. Sources : GITHUB_PR erp-crp-backend#71, crp-systems-web#126 — VALIDÉ.",
  },
  {
    code: "LOT-10.8", parent: "EPIC-10", title: "T9-T11 : conformité, plan E2E, release prod pilote", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Preuves/registre risques (T9), plan+seeds E2E (T10), rapport final + gate prod (T11), release dev→main, DB cerp_prod migrée, smoke vert. Sources : GITHUB_PR crp-systems-web#127/#128/#129, erp-crp-backend#72/#73/#74/#75, docs/ai/temps-deplacements-*.md — VALIDÉ.",
  },
  {
    code: "LOT-10.9", parent: "EPIC-10", title: "Recette RH réelle + badgeuse matérielle", type: "LOT",
    status: "IN_PROGRESS", start: "2026-07-10", due: "2026-09-30", progress: 20,
    description: "Recette utilisateur RH sur données réelles, raccordement badgeuse physique, E2E complet (dépend du backend cerp_test déployé). Source : docs/ai/temps-deplacements-final-report.md — À_COMPLÉTER.",
  },

  // ================================================================ EPIC-11
  {
    code: "EPIC-11", title: "Project Office et rapport de projet Bac+5", type: "EPIC",
    status: "IN_PROGRESS", priority: "HIGH", start: "2026-07-10", due: "2026-09-30", progress: 60,
    description:
      "Module de pilotage projet : macro-planning/Gantt/Kanban, cahier des charges versionné, décisions, risques, actions, preuves, rapport Bac+5 (16 sections) avec exports DOCX/MD. Module livré le 2026-07-10 (pilote KEENAN, fail-closed) ; peuplement avec l'historique réel en cours. Sources : GITHUB_PR erp-crp-backend#76/#77, crp-systems-web#131→#134, issue #130, ADR-0014 — VALIDÉ.",
  },
  {
    code: "LOT-11.1", parent: "EPIC-11", title: "Phases 0-2 : skills map, audit initial, architecture, ADR-0014", type: "DOC",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Cartographie des rôles, audit de l'existant, architecture du module, ADR-0014 accepté. Sources : GIT_COMMIT crp-systems-web 7bfc9dc, docs/ai/project-office-*.md, docs/architecture/module-project-office-macro-planning.md, docs/adr/ADR-project-office-macro-planning.md — VALIDÉ.",
  },
  {
    code: "LOT-11.2", parent: "EPIC-11", title: "Backend : schéma 27 tables + ~45 endpoints + gate fail-closed", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Patches 20260710_project_office_core/report/report_files, feature flags, middleware d'accès, anti-IDOR, DOCX. Sources : GITHUB_PR erp-crp-backend#76 (commits a12db43/6be4cae/2b8b28f), 6 fichiers de tests — VALIDÉ.",
  },
  {
    code: "LOT-11.3", parent: "EPIC-11", title: "Frontend : workspace gardé 11 pages + fix routing", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Pages Dashboard/Planning/Kanban/Tâches/CDC/Décisions/Risques/Actions/Preuves/Rapports/Rapport Bac+5, nav gardée par /access. Sources : GITHUB_PR crp-systems-web#131/#133 — VALIDÉ.",
  },
  {
    code: "LOT-11.4", parent: "EPIC-11", title: "Release pilote + seeds flags (KEENAN, fail-closed prod)", type: "LOT",
    status: "DONE", start: "2026-07-10", due: "2026-07-10", progress: 100,
    description: "Seeds flag baseline/enable-test/pilote KEENAN + template rapport 16×64, releases dev→main. Sources : GITHUB_PR erp-crp-backend#77, crp-systems-web#132/#134, db/seeds/project-office-* — VALIDÉ.",
  },
  {
    code: "LOT-11.5", parent: "EPIC-11", title: "Peuplement du module avec l'historique réel du projet", type: "LOT",
    status: "REVIEW", priority: "HIGH", start: "2026-07-10", due: "2026-07-17", progress: 90,
    description: "Import idempotent : projet CERP, EPICs/lots/tâches datés Git/PR, 16 jalons, CDC 5 versions, 17 décisions, risques, actions, preuves, rapport Bac+5 + captures (Pencil, ERP, GitKraken). Sources : scripts/project-office/populate-cerp-project.ts, docs/ai/project-office-population-*.md — VALIDÉ (en cours, cette opération).",
  },
  {
    code: "LOT-11.6", parent: "EPIC-11", title: "Rapport Bac+5 : rédaction sur preuves + validation des sections", type: "LOT",
    status: "IN_PROGRESS", start: "2026-07-10", due: "2026-09-15", progress: 35,
    description: "Passage des 16 sections de BROUILLON_IA à VALIDE après relecture, liaison preuves/captures section par section. Source : module Project Office (rapport) — BROUILLON_IA à relire.",
  },
  {
    code: "LOT-11.7", parent: "EPIC-11", title: "Exports DOCX/MD + recette pilote du module", type: "LOT",
    status: "IN_PROGRESS", start: "2026-07-10", due: "2026-07-31", progress: 70,
    description: "Exports vérifiés en prod le 2026-07-10 (section DOCX, rapport complet 3,3 Mo avec images, markdown, checksums SHA-256 en base). Reste : recette navigateur par l'utilisateur pilote. Source : project_report_exports — VALIDÉ pour les exports, recette À VALIDER.",
  },

  // ================================================================ EPIC-12
  {
    code: "EPIC-12", title: "Tests, stabilisation, déploiement pilote", type: "EPIC",
    status: "IN_PROGRESS", priority: "HIGH", start: "2025-07-20", due: "2026-12-18", progress: 55,
    description:
      "CI qualité avec gate prod, tests unitaires/intégration Vitest, smoke tests API par phase, E2E Playwright + captures, déploiements VPS Coolify + atelier, performance. Sources : GITHUB_PR #30 (CA-DEV-01), workflows CI, scripts smoke — VALIDÉ pour le réalisé.",
  },
  {
    code: "LOT-12.1", parent: "EPIC-12", title: "CI : portail qualité + gate du déploiement prod (CA-DEV-01)", type: "INFRA",
    status: "DONE", start: "2026-07-07", due: "2026-07-07", progress: 100,
    description: "Typecheck/tests/build bloquants avant deploy prod. Sources : GITHUB_PR erp-crp-backend#30, .github/workflows/ci.yml + deploy.yml — VALIDÉ.",
  },
  {
    code: "LOT-12.2", parent: "EPIC-12", title: "Tests unitaires et d'intégration (Vitest)", type: "LOT",
    status: "IN_PROGRESS", start: "2025-07-20", due: "2026-12-18", progress: 55,
    description: "Suites Vitest backend (auth baseline, project-office ×6, temps-déplacements…) et frontend (guards, pages, hooks). Couverture à étendre sur les modules 2026-02. Source : src/__tests__/ des 2 repos — VALIDÉ pour l'existant.",
  },
  {
    code: "LOT-12.3", parent: "EPIC-12", title: "Smoke tests API par phase + vérifications SQL", type: "LOT",
    status: "DONE", start: "2026-02-01", due: "2026-07-09", progress: 100,
    description: "Scripts phase2→phase13c, réceptions, nomenclature, pack expédition, gpao-b6-e2e.sh. Source : erp-crp-backend/scripts/*.js — VALIDÉ.",
  },
  {
    code: "LOT-12.4", parent: "EPIC-12", title: "E2E Playwright + génération de captures documentaires", type: "LOT",
    status: "IN_PROGRESS", start: "2026-06-24", due: "2026-10-30", progress: 40,
    description: "E2E Playwright (E2E_CAPTURE_DOCS=1 génère les captures docs) ; E2E complet Temps & Déplacements dépend du backend cerp_test déployé. Source : README frontend, docs/ai/temps-deplacements-final-report.md — À_COMPLÉTER.",
  },
  {
    code: "LOT-12.5", parent: "EPIC-12", title: "Déploiements : VPS Coolify (web) + atelier HYPERBOX2 (DB/desktop)", type: "INFRA",
    status: "IN_PROGRESS", start: "2025-08-01", due: "2026-09-30", progress: 80,
    description: "Frontend cerp.croix-rousse-precision.fr + backend erp-backend.croix-rousse-precision.fr (Coolify) sur DB atelier via WireGuard ; incident connectivité 2026-07-06 résolu. Backend dédié cerp_test à déployer. Sources : docs/devops/* (coolify, cerp-wireguard-*), DOC_SOURCE erp-crp-backend/docs/hosting-and-database-access.md — VALIDÉ ; backend test À PLANIFIER.",
  },
  {
    code: "LOT-12.6", parent: "EPIC-12", title: "Recette navigateur complète + stabilisation des flux démo", type: "LOT",
    status: "READY", start: "2026-09-01", due: "2026-12-18", progress: 5,
    description: "Recette bout-en-bout par module (issue #40 stabilisation flows démo) avant élargissement des utilisateurs. Source : crp-systems-web issue #40 — À PLANIFIER.",
  },
  {
    code: "LOT-12.7", parent: "EPIC-12", title: "Performance : chunks, lazy-loading, dépendances runtime", type: "LOT",
    status: "DONE", start: "2026-07-07", due: "2026-07-09", progress: 100,
    description: "Split vendor chunks 5→2,5 Mo (A5), lazy-loading des pages dashboard, fix ws High (CA-DEV-04). Sources : GITHUB_PR crp-systems-web#93/#103/#117 — VALIDÉ.",
  },

  // ================================================================ EPIC-13
  {
    code: "EPIC-13", title: "Formation, documentation utilisateur, bilan", type: "EPIC",
    status: "BACKLOG", priority: "NORMAL", start: "2026-10-01", due: "2027-12-17", progress: 5,
    description:
      "Guides utilisateur par module, formation des utilisateurs internes, documentation d'exploitation, bilan de projet et démonstration finale. Sources : docs/user-guide/ (squelette), macro-planning — À PLANIFIER.",
  },
  {
    code: "LOT-13.1", parent: "EPIC-13", title: "Guides utilisateur par module", type: "DOC",
    status: "BACKLOG", start: "2027-01-04", due: "2027-06-30", progress: 0, assign: false,
    description: "Guides pas-à-pas par module (commerce, production, stock, qualité, RH). Source : docs/user-guide/README.md (squelette) — À PLANIFIER.",
  },
  {
    code: "LOT-13.2", parent: "EPIC-13", title: "Formation des utilisateurs internes", type: "LOT",
    status: "BACKLOG", start: "2027-04-01", due: "2027-11-30", progress: 0, assign: false,
    description: "Sessions de formation par service (gestion, atelier, qualité, RH) avant bascule complète. Source : macro-planning — À PLANIFIER.",
  },
  {
    code: "LOT-13.3", parent: "EPIC-13", title: "Documentation d'exploitation (runbooks)", type: "DOC",
    status: "IN_PROGRESS", start: "2026-07-06", due: "2027-03-31", progress: 40,
    description: "Runbooks existants (HYPERBOX2 postgres, WireGuard, incidents) à compléter (backup/restore formalisé, supervision). Source : docs/devops/ — VALIDÉ pour l'existant, À_COMPLÉTER.",
  },
  {
    code: "LOT-13.4", parent: "EPIC-13", title: "Bilan de projet et démonstration finale", type: "LOT",
    status: "BACKLOG", start: "2027-05-03", due: "2027-06-30", progress: 0, assign: false,
    description: "Bilan (réalisé/écarts/enseignements) + démonstration finale (jalon J14). Source : macro-planning — À PLANIFIER.",
  },

  // ================================================================ EPIC-14
  {
    code: "EPIC-14", title: "Roadmap future : achats, GED, reporting, MES, CBN/CCBN, TRS, PIC/PDP", type: "EPIC",
    status: "BACKLOG", priority: "NORMAL", start: "2027-01-04", due: "2027-12-17", progress: 0,
    description:
      "Briques 2027 : fournisseurs/achats, GED, reporting/BI, MES tablettes atelier, calcul des besoins nets (CBN/CCBN), TRS, PIC/PDP. Source : DOC_SOURCE note du 25/06 + roadmap — À PLANIFIER (aucun engagement de périmètre).",
  },
  {
    code: "LOT-14.1", parent: "EPIC-14", title: "Fournisseurs et achats (commandes fournisseur, AR, relances)", type: "LOT",
    status: "BACKLOG", start: "2027-01-04", due: "2027-03-31", progress: 0, assign: false,
    description: "Cycle achats complet adossé aux réceptions existantes. Source : docs/architecture/fournisseurs-ecosystem.md — À PLANIFIER (2027-T1).",
  },
  {
    code: "LOT-14.2", parent: "EPIC-14", title: "GED : gestion documentaire technique centralisée", type: "LOT",
    status: "BACKLOG", start: "2027-01-04", due: "2027-06-30", progress: 0, assign: false,
    description: "Stockage central des plans/documents avec indices et diffusion contrôlée (esprit PDM/SGDT). Source : DOC_SOURCE Exp-PDM-SGDT-4p.pdf, note du 25/06 — À PLANIFIER.",
  },
  {
    code: "LOT-14.3", parent: "EPIC-14", title: "Reporting et indicateurs transverses", type: "LOT",
    status: "BACKLOG", start: "2027-04-01", due: "2027-06-30", progress: 0, assign: false,
    description: "Tableaux de bord transverses (commerce, production, qualité, RH). Source : roadmap — À PLANIFIER (2027-T2).",
  },
  {
    code: "LOT-14.4", parent: "EPIC-14", title: "MES : tablettes atelier, déclarations temps réel", type: "LOT",
    status: "BACKLOG", start: "2027-04-01", due: "2027-09-30", progress: 0, assign: false,
    description: "Déclarations au poste (démarrage/fin d'opération, quantités, aléas) sur tablette. Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2027-T2/T3).",
  },
  {
    code: "LOT-14.5", parent: "EPIC-14", title: "CBN / CCBN : calcul des besoins nets", type: "LOT",
    status: "BACKLOG", start: "2027-07-01", due: "2027-09-30", progress: 0, assign: false,
    description: "Calcul des besoins nets (et besoins de charge) sur nomenclatures + stock + commandes. Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2027-T3).",
  },
  {
    code: "LOT-14.6", parent: "EPIC-14", title: "TRS : taux de rendement synthétique", type: "LOT",
    status: "BACKLOG", start: "2027-07-01", due: "2027-09-30", progress: 0, assign: false,
    description: "TRS machines à partir des déclarations MES. Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2027-T3), dépend de LOT-14.4.",
  },
  {
    code: "LOT-14.7", parent: "EPIC-14", title: "PIC / PDP : plan industriel et commercial, plan directeur", type: "LOT",
    status: "BACKLOG", start: "2027-10-01", due: "2027-12-17", progress: 0, assign: false,
    description: "PIC/PDP sur l'horizon moyen terme, alimentés par CBN et carnet de commandes. Source : DOC_SOURCE note du 25/06 — À PLANIFIER (2027-T4).",
  },
  {
    code: "LOT-14.8", parent: "EPIC-14", title: "Release finale décembre 2027 (stabilisation générale)", type: "LOT",
    status: "BACKLOG", start: "2027-10-01", due: "2027-12-17", progress: 0, assign: false,
    description: "Consolidation, gel du périmètre, release de fin de macro-planning (jalon J15). Source : macro-planning — À PLANIFIER.",
  },
];
