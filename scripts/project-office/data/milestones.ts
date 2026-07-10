import type { DependencyDef, MilestoneDef } from "../types";

/** 16 jalons J0→J15. REACHED uniquement si preuve (PR/commit/déploiement). */
export const MILESTONES: MilestoneDef[] = [
  { name: "J0 — Démarrage projet / prise de contexte", due: "2025-07-15", status: "REACHED",
    description: "Premier commit backend (GIT_COMMIT c6fd108, 2025-07-15) ; frontend le 2025-07-18 (a892af7). Cadrage métier antérieur (analyse du contexte CLIPPER 07)." },
  { name: "J1 — Socle frontend/backend opérationnel", due: "2025-10-31", status: "REACHED",
    description: "Ossature API Express/TS, frontend React/Vite/TS + UI kit, CI/CD SCP, Docker/Nginx. Preuves : git log 2025-07→10." },
  { name: "J2 — Authentification et choix base prod/test", due: "2026-06-23", status: "REACHED",
    description: "Auth JWT (2025-07/08) puis sélecteur cerp_prod/cerp_test au login avec header applicatif X-CERP-Database. Preuves : PRs erp-crp-backend#18/#19 (2026-06-23)." },
  { name: "J3 — Modules commerce exploitables", due: "2026-02-28", status: "REACHED",
    description: "Devis + commandes + affaires + facturation en place (pic de développement février 2026, 125 commits). Durcis ensuite par CA-APP-01/02 et A1-A6 (2026-07)." },
  { name: "J4 — Premiers flux production/GPAO", due: "2026-06-24", status: "REACHED",
    description: "Planning atelier (2026-02) puis arborescence de fabrication récursive et OF parent/enfant (PRs #23/#56, 2026-06-24, ADR-0012)." },
  { name: "J5 — Stock / livraisons / qualité en base", due: "2026-03-31", status: "REACHED",
    description: "Réceptions fournisseur, qualité (dispositions/KPI/lots), métrologie, traçabilité, livraisons (2026-02) ; stock articles versionné (2026-03)." },
  { name: "J6 — Sécurité et conformité renforcées", due: "2026-07-09", status: "REACHED",
    description: "Vague CA-SEC-01→04 + fix register + audit logs append-only + users_view RGPD + SMSI ISO 27001 fondé (PRs #28/#29/#51/#53/#61/#55, crp-systems-web#60/#105→#110, 2026-07-06→09)." },
  { name: "J7 — GPAO V2 / données techniques versionnées", due: "2026-07-09", status: "REACHED",
    description: "PDM V2 (versions/indices, achats typés, lien article↔pièce) + UI données techniques + tests métier B6 + release B7 (PRs #59/#60/#115, 2026-07-09)." },
  { name: "J8 — Temps & Déplacements", due: "2026-07-10", status: "REACHED",
    description: "Module complet T1→T11 mergé et déployé en pilote (PRs #64→#75 backend, #120→#129 frontend, issue #119, smoke prod vert)." },
  { name: "J9 — Project Office", due: "2026-07-10", status: "REACHED",
    description: "Module livré : 27 tables, ~45 endpoints, 11 pages, gate fail-closed, pilote KEENAN (PRs #76/#77 backend, #131→#134 frontend, issue #130, ADR-0014)." },
  { name: "J10 — Rapport Bac+5 générable", due: "2026-07-31", status: "REACHED",
    description: "Rapport 16 sections alimenté par preuves. Atteint le 2026-07-10 : exports vérifiés en prod (SECTION_DOCX 12 Ko, FULL_DOCX 3,3 Mo avec captures embarquées, MARKDOWN), checksums SHA-256 journalisés dans project_report_exports." },
  { name: "J11 — Pilote utilisateur interne", due: "2026-09-30", status: "PLANNED",
    description: "Recette réelle par les utilisateurs pilotes (T&D côté RH, Project Office côté pilotage) et corrections issues de la recette." },
  { name: "J12 — Stabilisation complète", due: "2026-12-18", status: "PLANNED",
    description: "Flux démo stabilisés (issue #40), facturation/stock/livraisons complétés, dette Dependabot triée, E2E verts." },
  { name: "J13 — Audit interne / conformité", due: "2027-03-31", status: "PLANNED",
    description: "Audit interne ISO 27001 (périmètre CERP), revue Air Cyber, registre CAPA à jour, procédure backup/restore testée et documentée." },
  { name: "J14 — Démonstration finale", due: "2027-06-30", status: "PLANNED",
    description: "Démonstration bout-en-bout (devis → commande → OF → livraison → facture + RH + pilotage) et soutenance du rapport." },
  { name: "J15 — Release décembre 2027", due: "2027-12-17", status: "PLANNED",
    description: "Fin du macro-planning : briques roadmap (achats, GED, reporting, MES, CBN/CCBN, TRS, PIC/PDP) selon arbitrages, release stabilisée." },
];

/** Dépendances structurantes (Gantt / vue chef de projet). */
export const DEPENDENCIES: DependencyDef[] = [
  { source: "LOT-04.4", target: "LOT-04.3", type: "REQUIRES" },   // PDM V2 ← modèle cible P1/P2
  { source: "LOT-05.1", target: "LOT-04.5", type: "REQUIRES" },   // OF snapshot ← nomenclatures récursives
  { source: "LOT-05.4", target: "LOT-05.3", type: "REQUIRES" },   // planning ← machines
  { source: "LOT-05.5", target: "LOT-05.4", type: "REQUIRES" },   // retard réel ← planning
  { source: "LOT-05.7", target: "LOT-05.4", type: "REQUIRES" },   // vision OF machine ← planning
  { source: "LOT-03.3", target: "LOT-03.2", type: "REQUIRES" },   // commandes ← devis
  { source: "LOT-03.5", target: "LOT-03.3", type: "REQUIRES" },   // facturation ← commandes
  { source: "LOT-07.1", target: "LOT-03.3", type: "REQUIRES" },   // BL ← commandes
  { source: "LOT-07.1", target: "LOT-06.2", type: "REQUIRES" },   // BL ← stock articles
  { source: "LOT-11.6", target: "LOT-11.5", type: "REQUIRES" },   // rédaction rapport ← peuplement preuves
  { source: "LOT-11.7", target: "LOT-11.6", type: "REQUIRES" },   // exports/recette ← rédaction
  { source: "LOT-10.9", target: "LOT-12.5", type: "BLOCKS" },     // recette T&D bloquée par backend cerp_test (déploiement)
  { source: "LOT-14.4", target: "LOT-05.4", type: "REQUIRES" },   // MES ← planning atelier
  { source: "LOT-14.5", target: "LOT-06.4", type: "REQUIRES" },   // CBN ← magasins/mouvements
  { source: "LOT-14.5", target: "LOT-04.5", type: "REQUIRES" },   // CBN ← nomenclatures
  { source: "LOT-14.6", target: "LOT-14.4", type: "REQUIRES" },   // TRS ← MES
  { source: "LOT-14.7", target: "LOT-14.5", type: "REQUIRES" },   // PIC/PDP ← CBN
  { source: "LOT-09.8", target: "LOT-09.1", type: "REQUIRES" },   // audit interne ← SMSI
];
