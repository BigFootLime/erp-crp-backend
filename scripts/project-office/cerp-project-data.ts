import type { PopulationData } from "./types";
import { WP_CORE } from "./data/wp-core";
import { WP_TRANSVERSE } from "./data/wp-transverse";
import { MILESTONES, DEPENDENCIES } from "./data/milestones";
import { DECISIONS, RISKS, ACTIONS } from "./data/registers";
import { EVIDENCE, EXTERNAL_LINKS } from "./data/evidence";
import { REPORT_ENTRIES, REPORT_ENTRY_EVIDENCE, REPORT_VERSIONS } from "./data/report-entries";
import { SPEC_VERSIONS } from "./data/spec-versions";

/**
 * Modèle de peuplement du Project Office avec le pilotage réel du projet CERP.
 * cible test : projet TEST_CERP (owner GPAOTEST) — règle de préfixage des données de test ;
 * cible prod : projet CERP (owner KEENAN, pilote du module).
 */
export const DATA: PopulationData = {
  targets: {
    test: { database: "cerp_test", ownerUsername: "GPAOTEST", projectCode: "TEST_CERP", prefix: "TEST_PROJECT_OFFICE — " },
    prod: { database: "cerp_prod", ownerUsername: "KEENAN", projectCode: "CERP", prefix: "" },
  },
  project: {
    name: "CERP — ERP Croix Rousse Précision",
    description:
      "Développement d'un ERP sur mesure pour Croix Rousse Précision afin de remplacer progressivement CLIPPER 07, centraliser les flux métier, améliorer la traçabilité, moderniser l'interface et conserver la maîtrise interne du système d'information. Ce projet est piloté dans ce module (macro-planning J0→J15, registres, preuves) qui est aussi la source de vérité du rapport Bac+5. Période : 2025-07-15 (premier commit backend) → 2027-12-31 (fin de macro-planning).",
    visibility: "PILOT",
    status: "ACTIVE",
    startDate: "2025-07-15",
    targetDate: "2027-12-31",
  },
  workPackages: [...WP_CORE, ...WP_TRANSVERSE],
  dependencies: DEPENDENCIES,
  milestones: MILESTONES,
  spec: {
    title: "Cahier des charges fonctionnel CERP",
    status: "REVIEW",
    currentVersion: "V3",
    versions: SPEC_VERSIONS,
  },
  decisions: DECISIONS,
  risks: RISKS,
  actions: ACTIONS,
  evidence: EVIDENCE,
  externalLinks: EXTERNAL_LINKS,
  report: {
    title: "Rapport de projet CERP — Bac+5",
    academicYear: "2026-2027",
    status: "IN_PROGRESS",
    currentVersion: "V2",
    entries: REPORT_ENTRIES,
    entryEvidence: REPORT_ENTRY_EVIDENCE,
    versions: REPORT_VERSIONS,
  },
};
