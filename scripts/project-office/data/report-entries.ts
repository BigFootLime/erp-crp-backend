import type { ReportEntryDef, ReportEntryEvidenceDef, ReportVersionDef } from "../types";

/**
 * Entrées du rapport « Rapport de projet CERP — Bac+5 » (template RAPPORT_BAC5_CERP).
 * Règles : tout texte généré = BROUILLON_IA (à relire) ; preuve manquante = A_DOCUMENTER
 * avec [À compléter] ; jamais de fait inventé. progress_percent = maturité de la section.
 */
export const REPORT_ENTRIES: ReportEntryDef[] = [
  // ============================================================ 1. Analyse du besoin
  {
    section: "1", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA — à relire. Preuves : [DOC_SOURCE analyse], [DOC_SOURCE rapport], [DOC_SOURCE genese].

Croix Rousse Précision (CRP) est un atelier d'usinage de précision dont la gestion repose sur CLIPPER 07, complété par des fichiers Excel (suivi de projet, codification). Ce socle montre ses limites : interface datée, saisies redondantes entre devis, commandes, ordres de fabrication et livraisons, traçabilité laborieuse (relier une pièce livrée à son lot, son OF et son indice de plan demande des recoupements manuels), et une dépendance forte à l'éditeur pour toute évolution.

Le projet CERP répond à ce constat : construire un ERP interne sur mesure qui centralise les flux métier, améliore la traçabilité et redonne à l'entreprise la maîtrise de son système d'information. Le besoin a été analysé service par service (production, gestion/administration, qualité, direction) à partir des irritants quotidiens documentés dans l'« Analyse du contexte et des besoins ».

L'étude des alternatives (conserver CLIPPER, acheter un progiciel, développer en interne) a conclu au développement interne : coût de licences nul, adéquation exacte aux processus de l'atelier, et donnée exploitable pour les automatisations futures. [À compléter : chiffrage comparatif détaillé si disponible.]`,
  },
  {
    section: "1.1", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. CERP (« ERP Croix Rousse Précision ») : ERP interne destiné à remplacer progressivement CLIPPER 07. Deux applications (frontend React, API Express) et une base PostgreSQL unique source de vérité, développées depuis juillet 2025 (premiers commits : backend 2025-07-15, frontend 2025-07-18).`,
  },
  {
    section: "1.2", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Problème : CLIPPER 07 vieillissant — ressaisies multiples, traçabilité difficile, rigidité des flux, interface datée, dépendance éditeur, donnée difficile d'accès. Conséquences mesurables : temps administratif perdu et risque d'erreur à chaque recopie. Source : Analyse du contexte et des besoins.`,
  },
  {
    section: "1.3", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Trois options étudiées : (1) maintenir/aménager CLIPPER — écarté, le cœur du problème demeure ; (2) progiciel du marché — écarté : licences, flux imposés, donnée externalisée ; (3) développement interne sur mesure — retenu (décision D02). Le même arbitrage a été refait plus tard pour le pilotage projet : module Project Office interne plutôt que GitLab Premium (décision D14, ADR-0014).`,
  },
  {
    section: "1.4", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Utilisateurs cibles : production (opérateurs, responsables d'atelier), gestion/administration (devis, commandes, factures, livraisons), qualité (contrôles, non-conformités, métrologie), direction (pilotage), RH (module Temps & Déplacements), et le pilote projet (module Project Office). Rôles applicatifs correspondants dans la table users.`,
  },

  // ============================================================ 2. Cadrage
  {
    section: "2", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA — à relire. Preuves : [DOC_SOURCE genese], docs/rapport/02_cadrage_du_projet.md, CDC V0.

Le cadrage définit CERP comme un ERP modulaire de remplacement progressif : chaque module (clients, devis, commandes, articles, production, stock, livraisons, qualité, outillage…) est développé, validé puis substitué à l'usage CLIPPER correspondant, sans big-bang. Les parties prenantes sont la direction de CRP (sponsor), les responsables de service (métier), l'alternant (conception/développement/pilotage) et l'école (encadrement académique).

Les objectifs fonctionnels : centraliser les flux commerce → production → livraison → facturation ; garantir la traçabilité pièce/lot/OF/indice ; simplifier la saisie (une information n'est saisie qu'une fois) ; fournir des vues de pilotage. Le périmètre est volontairement progressif ; la paie et la comptabilité générale restent hors périmètre (exports seulement).

Le pilotage du projet lui-même est outillé par le module Project Office (macro-planning, jalons J0→J15, registres décisions/risques/preuves), qui constitue la source de vérité du présent rapport.`,
  },
  {
    section: "2.1", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. CERP = ERP interne sur mesure de Croix Rousse Précision. Nom, périmètre modulaire et stratégie de remplacement progressif actés au cadrage (V0 du cahier des charges, approuvée). Le projet court du 2025-07-15 (premier commit) au 2027-12-31 (fin du macro-planning).`,
  },
  {
    section: "2.2", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Parties prenantes : direction CRP (sponsor, arbitrages), responsables de service (expression de besoin, recette), alternant (conception, développement, exploitation, pilotage — risque R01 de dépendance documenté), tuteur entreprise et référent école (suivi académique). [À compléter : noms/rôles exacts à confirmer.]`,
  },
  {
    section: "2.3", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Objectifs fonctionnels mesurables : flux complet devis→commande→OF→livraison→facture réalisable dans CERP ; traçabilité totale des pièces livrées ; suppression des doubles saisies sur les modules basculés ; pilotage projet et rapport générés depuis des preuves (modules Project Office).`,
  },
  {
    section: "2.4", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Périmètre progressif par vagues : socle technique et auth (2025-T3), commerce (2025-T4→2026-T1), production/stock/qualité (2026-T1), données techniques GPAO/PDM V2 (2026-T3), RH pointage et pilotage (2026-T3), stabilisation (2026-T4), roadmap industrialisation (2027). Hors périmètre : paie interne, comptabilité générale, e-commerce.`,
  },

  // ============================================================ 3. Recueil des besoins
  {
    section: "3", status: "BROUILLON_IA", progress: 60,
    draft: `> BROUILLON_IA — à relire. Preuves : [DOC_SOURCE analyse], [DOC_SOURCE note-2026-06-25], issues GitHub (épiques).

Les besoins ont été recueillis au fil de l'eau auprès des services : gestion (devis/commandes/factures sans ressaisie), production (planning lisible, OF avec le bon indice de plan, arborescences de fabrication), qualité (contrôles, lots, traçabilité, moyens de mesure), magasin (stock, réceptions, sorties outillage), RH (pointage 35h/39h, kilomètres, exports paie), direction (avancement, risques, échéances).

La note métier du 25/06/2026 constitue le recueil le plus structurant : elle liste les exigences données techniques (rang d'application, pièces cyclées, nomenclatures, gammes), production (figer le planning, retard réel, sous-traitance, vision OF machine) et les briques d'industrialisation (MES, CBN/CCBN, TRS, PIC/PDP) — intégrées au cahier des charges V3/V4 et au macro-planning.

La priorisation a suivi la valeur métier immédiate : d'abord le flux commercial (le plus douloureux sous CLIPPER), puis production/stock/qualité, puis les données techniques versionnées, enfin le pilotage. [À compléter : comptes rendus d'entretiens formalisés — le recueil s'est fait en continu, peu de traces datées.]`,
  },
  {
    section: "3.1", status: "BROUILLON_IA", progress: 65,
    draft: `> BROUILLON_IA. Besoins par service documentés dans l'analyse du contexte puis affinés en continu (l'alternant travaille dans l'atelier). Formalisation a posteriori dans le CDC versionné (V0→V3) et les issues épiques GitHub (#119 RH, #130 pilotage, #12/#19/#20 manufacturing/planning).`,
  },
  {
    section: "3.2", status: "A_DOCUMENTER", progress: 15,
    notes: "Personas non formalisés à ce stade. À produire : 4-5 personas (opérateur, resp. atelier, gestionnaire, qualité, direction) à partir des rôles applicatifs existants.",
    draft: `> BROUILLON_IA. [À compléter] Les personas ne sont pas formalisés en tant que tels ; les rôles applicatifs (Directeur, Employee, Responsable Qualité, Responsable Programmation, Secrétaire, Responsable RH…) et les gardes d'accès par module en tiennent lieu. Une fiche persona par profil reste à rédiger pour la soutenance.`,
  },
  {
    section: "3.3", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Fonctionnalités principales retenues : référentiels (clients, articles, pièces techniques), chaîne commerciale (devis, commandes 3 types, affaires, facturation), production (planning, OF récursifs, gammes), logistique (stock, réceptions, livraisons, outillage), qualité/traçabilité, RH pointage, pilotage projet. Détail par module dans le CDC V2/V3.`,
  },
  {
    section: "3.4", status: "BROUILLON_IA", progress: 65,
    draft: `> BROUILLON_IA. Priorisation par la douleur métier et les dépendances : commerce d'abord, production/stock ensuite, données techniques versionnées avant l'industrialisation (MES/CBN reportés en 2027, décision D17). Priorités visibles dans le macro-planning (priority HIGH/CRITICAL sur les EPICs structurants).`,
  },

  // ============================================================ 4. Contraintes
  {
    section: "4", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA — à relire. Preuves : [DOC_SOURCE hosting], [DOC_SOURCE incident], registre des risques.

Contraintes techniques : un seul développeur, donc une stack homogène TypeScript de bout en bout ; PostgreSQL sur le serveur atelier HYPERBOX2 ; déploiement web sur VPS (Coolify) relié à la base atelier par WireGuard ; un client desktop Electron pour l'atelier (local-first). L'incident de connectivité du 2026-07-06 (dérive de configuration entre .env atelier et Coolify) a montré la sensibilité de cette topologie et conduit à durcir la gestion des secrets et les sauvegardes.

Contraintes de temps : projet mené en alternance, en parallèle des tâches d'entreprise ; le rythme réel le montre (pic février 2026, pause avril-mai 2026, reprise industrialisée depuis juin 2026 avec le workflow PR). Contraintes de sécurité : données clients et RH sensibles (RGPD), exigences cyber des clients aéronautiques (grille Air Cyber), d'où la vague CA-SEC (default-deny, rate-limit, audit logs append-only, erreurs génériques) et le SMSI ISO 27001.

Contraintes d'environnement : l'atelier impose la disponibilité locale (coupures internet possibles), des postes Windows, et une base unique partagée entre les déploiements — ce qui a dicté le stockage des fichiers du module Project Office en base (base64 + checksum).`,
  },
  {
    section: "4.1", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Techniques : mono-développeur → TypeScript partout, SQL manuscrit lisible, monolithe modulaire ; deux déploiements backend (VPS + atelier) partageant une seule base → fichiers en base, migrations idempotentes ; postes atelier Windows → CERP Desktop Electron.`,
  },
  {
    section: "4.2", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Temps : alternance (activité entreprise en parallèle), objectif rapport/soutenance mi-2027, macro-planning jusqu'à décembre 2027. Le git log matérialise la contrainte : 125 commits en février 2026, 0 en mai 2026, 125 PRs mergées en 10 jours en juillet 2026.`,
  },
  {
    section: "4.3", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Sécurité : RGPD (minimisation users_view CA-RGPD-07, données RH du pointage), exigences clients aéronautiques (Air Cyber), ISO 27001 (SMSI fondé : scope, SoA, registres). Mesures livrées : CA-SEC-01→04, fix register, audit logs append-only, rate-limit, gate CI avant prod.`,
  },
  {
    section: "4.4", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Environnement : atelier (HYPERBOX2 : PostgreSQL, WireGuard), VPS Coolify (front + API web), réseau atelier↔VPS par tunnel, postes opérateurs Windows. Runbooks : hyperbox2-postgres, cerp-wireguard-*, incident 2026-07-06 documenté et résolu.`,
  },

  // ============================================================ 5. Spécifications
  {
    section: "5", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA — à relire. Preuves : [DOC_SOURCE cdc], CDC versionné du module (V0→V4).

Les spécifications vivent dans le cahier des charges fonctionnel versionné du module Project Office : V0 (cadrage initial, approuvée), V1 (architecture modulaire, approuvée — adossée aux ADR 0001→0011), V2 (socle métier livré, approuvée — consolidation du CDC docs-as-code v2.0 du 2026-07-03, 74 Ko), V3 (données techniques/GPAO V2/pilotage, en relecture) et V4 (cible décembre 2027, brouillon roadmap non engagé).

Chaque version décrit contexte, objectifs, périmètre, hors-périmètre, utilisateurs, modules, règles métier, contraintes, critères d'acceptation et risques, avec ses preuves. Les règles métier clés sont vérifiables en base et dans le code : totaux devis recalculés serveur (CA-APP-01), statuts canoniques avec CHECK (CA-APP-02), snapshot de structure des OF (ADR-0012), commande CADRE avec appels de livraison.

Les cas d'usage détaillés et leur validation formelle par le tuteur restent à consolider pour la soutenance [À compléter].`,
  },
  {
    section: "5.1", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Spécifications fonctionnelles = CDC versionné (5 versions dans le module, historique complet docs/cahier-des-charges-erp-crp.md). Découpage par module avec règles métier explicites (3 types de commande, affaire projet obligatoire pour article fabriqué, nomenclatures fabrication/achat séparées).`,
  },
  {
    section: "5.2", status: "BROUILLON_IA", progress: 55,
    draft: `> BROUILLON_IA. Cas d'usage principaux couverts par les smoke tests par phase (phase2→13c : devis→commande, réceptions, pack expédition, nomenclature, GPAO B6 e2e) qui rejouent les scénarios métier de bout en bout côté API. [À compléter : formalisation rédigée des cas d'usage pour le dossier de soutenance.]`,
  },
  {
    section: "5.3", status: "BROUILLON_IA", progress: 65,
    draft: `> BROUILLON_IA. Critères d'acceptation par version du CDC (V2 : smoke verts + flux complet démontrable + contraintes DB actives ; V3 : évolution d'indice sans impact sur OF lancés, pilotage hors Excel, rapport sourcé). Vérifiés par tests automatisés et contraintes en base plutôt que par simple relecture.`,
  },
  {
    section: "5.4", status: "A_DOCUMENTER", progress: 20,
    notes: "Preuve de validation par le tuteur/encadrant à consolider (ADR-0013 mentionne une validation superviseur pour T&D ; généraliser).",
    draft: `> BROUILLON_IA. [À compléter] Validations tracées : ADR-0013 (Temps & Déplacements) porte la mention « validé superviseur » (2026-07-09) ; les approbations V0/V1/V2 du CDC sont enregistrées dans le module. Il manque une trace formelle de validation par le tuteur école sur le CDC global — à obtenir avant soutenance.`,
  },

  // ============================================================ 6. Conception UX/UI
  {
    section: "6", status: "BROUILLON_IA", progress: 55,
    draft: `> BROUILLON_IA — à relire. Preuves : maquettes Pencil (assets), DESIGN_SYSTEM.md, PRs UX A1-A6.

Le parti pris UX : l'inverse de l'« usine à gaz » — écrans par tâche métier, tableaux denses mais lisibles avec trois modes d'affichage (tableau, cartes, liste), formulaires guidés, feedback immédiat (toasts, badges de statut). Le design system (DESIGN_SYSTEM.md, shadcn/tailwind) fixe composants et thèmes ; les maquettes Pencil (kit + écrans clés, deux itérations dont une version double-thème) ont servi de référence visuelle avant implémentation.

Les parcours utilisateur suivent les flux métier réels : devis → commande (3 types explicites avec badges A1), commande → OF (arborescence), OF → livraison → facture. La vague UX de juillet 2026 (A1-A6) a corrigé les irritants relevés à l'usage : badges/résumés de commande, auto-format code postal, totaux/remises lisibles, aide contextuelle article fabriqué→projet, bouton Réessayer sur erreur.

La validation formelle des écrans par les utilisateurs finaux reste partielle (recette pilote planifiée, jalon J11) [À compléter].`,
  },
  {
    section: "6.1", status: "BROUILLON_IA", progress: 50,
    draft: `> BROUILLON_IA. Wireframes/maquettes réalisés sous Pencil (projets design : kit de composants + écrans modules, puis itération « VFinal » double thème clair/sombre). Exports liés en assets de ce rapport. Les écrans réels s'appuient sur le design system shadcn/tailwind du repo.`,
  },
  {
    section: "6.2", status: "BROUILLON_IA", progress: 55,
    draft: `> BROUILLON_IA. Parcours clés implémentés : connexion (avec choix de base), tableau de bord → module, devis→commande→OF→BL→facture, pointage salarié (badge/borne), pilotage (dashboard projet → Gantt/Kanban → tâche → preuves). Navigation latérale par domaine avec gardes d'accès.`,
  },
  {
    section: "6.3", status: "BROUILLON_IA", progress: 55,
    draft: `> BROUILLON_IA. Maquettes Pencil : kit (boutons, tables, formulaires, badges) + écrans par module ; seconde itération VFinal avec thème double et composants consolidés. Captures exportées et liées en assets. Écarts maquette/implémentation non bloquants documentés au fil des PRs UX.`,
  },
  {
    section: "6.4", status: "A_DOCUMENTER", progress: 15,
    notes: "Validation des écrans par les utilisateurs finaux à tracer lors de la recette pilote (J11).",
    draft: `> BROUILLON_IA. [À compléter] Pas encore de validation formelle des écrans par les utilisateurs finaux : la recette pilote (jalon J11, 2026-09) fournira les preuves (comptes rendus + corrections). Les validations actuelles sont techniques (tests de rendu par page) et internes.`,
  },

  // ============================================================ 7. Conception technique
  {
    section: "7", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA — à relire. Preuves : ADR 0001→0014, [MIGRATION] db/patches, Swagger, [DOC_SOURCE hosting].

Architecture : monolithe modulaire. Frontend React 18 + Vite + TypeScript (29 modules UI), backend Express + TypeScript (36 modules métier) exposant /api/v1 (REST, Swagger) + Socket.IO pour le temps réel (chat, verrous, notifications), PostgreSQL unique source de vérité (~190 tables sur cerp_prod). Validation Zod à l'entrée, backend autoritaire sur les règles métier (D06), couches routes→controllers→services→repository.

La base évolue par patches SQL additifs idempotents (db/patches, convention YYYYMMDD_name.sql) avec scripts verify/rollback, appliqués sur cerp_test puis cerp_prod. Les choix structurants sont tracés en ADR : monolithe modulaire (0001), Electron (0002), PostgreSQL (0003), Coolify (0006), GitHub Actions (0007), RBAC/audit (0008), outbox (0009), docs-as-code (0010), snapshots OF (0012), module RH (0013), Project Office (0014).

Le module Project Office illustre le modèle : 27 tables (cœur + rapport), ~45 endpoints gardés par un feature flag fail-closed et un contrôle anti-IDOR ressource→projet→rôle, fichiers stockés en base (base64+checksum) car deux déploiements partagent la même donnée.`,
  },
  {
    section: "7.1", status: "BROUILLON_IA", progress: 85,
    draft: `> BROUILLON_IA. Choix actés en ADR : React/Vite/TS + shadcn (front), Express/TS/Zod + pg (back), PostgreSQL, Electron (desktop atelier), Coolify (déploiement), GitHub Actions (CI), Socket.IO (temps réel). Justifications et alternatives dans les ADR 0001→0011 et le registre de décisions (D03→D07).`,
  },
  {
    section: "7.2", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Monolithe modulaire : 36 modules backend (src/module/*) autonomes (routes/controllers/services/repository/validators), 29 modules frontend (src/modules/*). Transverse : auth default-deny, audit logs, notifications, verrous d'édition, feature flags par utilisateur. Deux déploiements backend (VPS + atelier) sur la même base.`,
  },
  {
    section: "7.3", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Modélisation : ~190 tables PostgreSQL, contraintes fortes (FK, CHECK, enums, colonnes générées — ex. severity = probability×impact des risques projet). Évolution par patches additifs versionnés + verify/rollback ; parité test/prod contrôlée. Modèle de domaine documenté (erp-domain-model.md).`,
  },
  {
    section: "7.4", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. API REST /api/v1 documentée Swagger, JWT obligatoire (montage après authenticateToken), validation Zod par route, erreurs génériques normalisées (CA-SEC-04), rate-limit sur login (CA-SEC-02), idempotence par clés naturelles sur les imports. Exemple complet : les ~45 endpoints du module Project Office.`,
  },

  // ============================================================ 8. Planification
  {
    section: "8", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA — à relire. Preuve vivante : le présent module Project Office (macro-planning, Gantt, jalons).

La planification est passée de fichiers Excel (« GESTION PROJET.xlsx », conservé comme preuve historique) à un macro-planning outillé dans CERP : 15 EPICs (00→14) découpés en lots et tâches, 16 jalons (J0 démarrage 2025-07-15 → J15 release décembre 2027), dépendances explicites (MES ← planning ; CBN ← stock+nomenclatures ; TRS ← MES ; PIC/PDP ← CBN).

Règles de datation : le réalisé porte les dates Git/PR réelles (ex. J8 Temps & Déplacements atteint le 2026-07-10, preuves PRs #64→#75) ; le futur est planifié par trimestre sans fausse précision ; l'incertain est marqué « À VALIDER / À PLANIFIER ». Neuf jalons sont atteints (J0→J9, preuves liées), six restent planifiés (J10→J15).

La priorisation suit valeur métier + dépendances + risques ; la vue « Reste à faire » du module matérialise le backlog priorisé jusqu'à décembre 2027 (stabilisation 2026-T4, industrialisation 2027).`,
  },
  {
    section: "8.1", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Découpage : EPIC (domaine) → LOT (livrable) → TASK/FEATURE (unité de travail), codes stables (EPIC-xx, LOT-xx.y, TSK-xx.y.z) servant de clés d'idempotence à l'import. 95+ éléments dans le macro-planning au 2026-07-10, chacun sourcé (GIT_COMMIT/GITHUB_PR/DOC_SOURCE).`,
  },
  {
    section: "8.2", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Planning à niveaux : annuel (2025 fondations, 2026 cœur+industrialisation du process, 2027 briques avancées), trimestriel (roadmap), daté au jour uniquement quand une preuve Git/PR existe. Gantt du module alimenté par start_date/due_date des lots ; jalons J0→J15 avec statuts REACHED/PLANNED.`,
  },
  {
    section: "8.3", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Priorisation : CRITICAL sur sécurité/auth (EPIC-02, EPIC-09), HIGH sur les chaînes métier bloquantes (commerce, données techniques, production) et le pilotage, NORMAL sur le confort. Arbitrages tracés en décisions (D17 : report MES/CBN/TRS/PIC/PDP en 2027).`,
  },
  {
    section: "8.4", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Livrables par jalon : J1 socle, J3 commerce exploitable, J7 GPAO V2, J8 module RH, J9 module pilotage, J10 rapport générable (DOCX), J11 recette pilote, J12 stabilisation, J14 démonstration, J15 release finale. Chaque jalon liste ses preuves dans le module.`,
  },

  // ============================================================ 9. Environnement
  {
    section: "9", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA — à relire. Preuves : [DOC_SOURCE hosting], workflows CI, [DOC_SOURCE incident].

Environnement de travail : GitHub (2 repos privés BigFootLime/crp-systems-web et BigFootLime/erp-crp-backend), GitKraken pour la visualisation Git, VS Code, pnpm/npm, Vitest, Playwright. Le versioning suit dev (intégration) / main (stable) avec branches feature/* et PRs obligatoires depuis le 2026-06-22 ; la CI GitHub Actions (typecheck, tests, build) conditionne le déploiement prod (CA-DEV-01).

Infrastructure : VPS (Coolify) hébergeant le frontend web cerp.croix-rousse-precision.fr et l'API erp-backend.croix-rousse-precision.fr ; serveur atelier HYPERBOX2 hébergeant PostgreSQL (cerp_prod ≈ 190 tables + cerp_test de validation), joint par WireGuard ; sauvegardes pg_dump testées (cerp-pg-backup.sh, /var/backups/cerp). CERP Desktop (Electron) tourne sur les postes atelier en local-first avec sélection d'API.

La configuration des bases sépare strictement prod et test (D08) : toute migration passe d'abord par cerp_test ; les données de test sont préfixées TEST_ ; le header applicatif X-CERP-Database indique le contexte sans piloter la connexion (D09).`,
  },
  {
    section: "9.1", status: "BROUILLON_IA", progress: 85,
    draft: `> BROUILLON_IA. Outils : GitHub (code, issues, PRs, Actions), GitKraken (graphe — capture liée), VS Code, pnpm/npm, Vitest, Playwright, Swagger, Coolify (déploiement), WireGuard (réseau atelier↔VPS), Pencil (maquettes), agents IA encadrés par AGENTS.md (issue-first, règles sécurité/RGPD).`,
  },
  {
    section: "9.2", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Configuration projet : monorepos séparés front/back, TypeScript strict, ESLint, conventions de commit (commitizen), variables d'environnement hors repo (.env atelier + Coolify — leçon de l'incident 2026-07-06 : les garder synchronisés), storage roots dédiés (documents, exports, images).`,
  },
  {
    section: "9.3", status: "BROUILLON_IA", progress: 85,
    draft: `> BROUILLON_IA. Versioning : dev = intégration, main = stable déployé (D10) ; feature/* → PR vers dev avec CI verte ; release = PR dev→main (pas encore de tags — piste d'amélioration ISO). 391 commits front + 315 back au 2026-07-10 ; workflow PR effectif depuis le 2026-06-22 (141 PRs mergées).`,
  },
  {
    section: "9.4", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Bases : cerp_prod (source de vérité) / cerp_test (validation) sur HYPERBOX2, rôle applicatif cerp_app moindre privilège, superuser via peer auth locale uniquement, patches additifs idempotents avec verify/rollback appliqués test→prod, backup avant toute opération prod (preuve [BACKUP] du 2026-07-10).`,
  },

  // ============================================================ 10. Fonctionnalités principales
  {
    section: "10", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA — à relire. Preuves : [GIT_LOG 2026-02], PRs CA-APP/GPAO, smoke tests.

Le cœur fonctionnel couvre la chaîne complète de l'atelier. Commerce : clients (contacts, adresses, modes de paiement), devis (totaux serveur, statuts canoniques, conversion), commandes 3 types (FERME/CADRE/INTERNE avec appels de livraison), affaires (livraison|projet), facturation. Production : planning atelier (machines/postes), OF parent/enfant avec snapshot de structure et référence article+indice, gammes et dossiers d'opération. Logistique : stock articles versionné, réceptions fournisseur contrôlées, bons de livraison avec allocations, outillage complet. Qualité : dispositions, KPI, lots, traçabilité, métrologie. Données techniques : pièces avec versions/indices, nomenclatures fabrication vs achat, achats typés (GPAO/PDM V2, B7).

L'organisation du code suit strictement les couches (routes→controllers→services→repository, validators Zod) ; les bonnes pratiques sont outillées (CI bloquante, conventions AGENTS.md/INSTRUCTIONS_BACKEND.md, revues via PR) ; chaque module récent embarque ses tests Vitest et ses smoke tests API.

Développement en trois vagues visibles au git log : fondations+outillage (2025-T3), commerce (2025-T4→2026-01), pic cœur ERP (2026-02 : 125 commits front), puis GPAO V2 (2026-07).`,
  },
  {
    section: "10.1", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Modules principaux livrés : auth, clients, devis, commandes (3 types), affaires, facturation (cœur), articles, pièces techniques (versions/indices), nomenclatures, gammes, production/OF, planning, stock, réceptions, livraisons, outillage, qualité, métrologie, traçabilité. Détail et preuves par lot dans le macro-planning (EPIC-03→08).`,
  },
  {
    section: "10.2", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Bonnes pratiques : PR + CI obligatoires (D11), validation Zod systématique, backend autoritaire (D06), migrations additives avec verify/rollback, secrets hors repo, conventions de commit, docs-as-code (ADR/CHANGELOG). L'historique pré-2026-06 (commits directs) a motivé le passage au workflow PR.`,
  },
  {
    section: "10.3", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Organisation : 36 modules backend isolés (src/module/<domaine>/routes|controllers|services|repository|validators|types), 29 modules frontend (src/modules/<domaine>/api|components|hooks|pages), composants UI partagés (shadcn), types partagés par contrat API.`,
  },
  {
    section: "10.4", status: "BROUILLON_IA", progress: 65,
    draft: `> BROUILLON_IA. Tests du cœur : suites Vitest backend (auth baseline, modules récents) et frontend (rendu pages, guards, hooks), smoke tests API par phase (phase2→13c) rejouant les flux métier, vérifications SQL dédiées (réceptions, phase3). Couverture inégale sur les modules de 2026-02 — chantier LOT-12.2.`,
  },

  // ============================================================ 11. Fonctionnalités secondaires
  {
    section: "11", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA — à relire. Preuves : PRs #64→#77 backend, #85→#134 frontend.

Au-delà du cœur ERP : chat interne temps réel (messagerie, groupes, présence — 2026-03), notifications, verrous d'édition collaboratifs (2026-02), CERP Desktop Electron (local-first atelier, auto-update contrôlé), et deux modules majeurs livrés en juillet 2026 : Temps & Déplacements (pointage append-only 35h/39h, corrections validées, kilomètres, exports paie figés avec checksum, bornes kiosk HID + badges — T1→T11, déployé pilote) et Project Office (le présent module de pilotage : macro-planning, Gantt, Kanban, CDC versionné, décisions, risques, preuves, rapport Bac+5, exports DOCX).

Amélioration UX continue (vague A1-A6) : badges/résumés de commande, auto-format code postal, totaux/remises lisibles, aides contextuelles, bouton Réessayer. Gestion des erreurs durcie : réponses génériques sans fuite d'internes (CA-SEC-04), bornage des attentes DB derrière le proxy (504 VPS), écrans d'erreur avec relance.

Sécurisation transverse : default-deny, rate-limit login, fix escalade register, audit logs append-only, users_view minimisée, feature flags par utilisateur (pattern Project Office, fail-closed).`,
  },
  {
    section: "11.1", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Complémentaires livrés : chat interne temps réel, notifications, verrous d'édition, CERP Desktop (Electron), module Temps & Déplacements complet (RH), module Project Office (pilotage + rapport), outillage avancé (dashboard), as-built. Preuves : PRs et git log liés aux lots EPIC-10/11.`,
  },
  {
    section: "11.2", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. UX : vague A1-A6 (2026-07-07) issue de l'audit — badges 3 types de commande, code postal auto, totaux/remise, aide article fabriqué→projet, split chunks (perf ressentie), Réessayer sur erreur. Trois modes d'affichage des tables (tableau/cartes/liste) généralisés.`,
  },
  {
    section: "11.3", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Gestion des erreurs : réponses génériques normalisées (CA-SEC-04), timeouts DB bornés sous le timeout proxy (PR back#26, issue #25), retry UI (A6), verrous d'édition contre les conflits, journal project_error_records prévu pour consigner erreurs/corrections du pilotage.`,
  },
  {
    section: "11.4", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Sécurisation : default-deny /api/v1 (CA-SEC-01), rate-limit login (CA-SEC-02), audit logs append-only (CA-SEC-03), erreurs génériques (CA-SEC-04), fix register (PR #28), users_view RGPD (CA-RGPD-07), feature flag fail-closed + anti-IDOR (Project Office), SCA Dependabot (P1.5).`,
  },

  // ============================================================ 12. Tests et validation
  {
    section: "12", status: "BROUILLON_IA", progress: 65,
    draft: `> BROUILLON_IA — à relire. Preuves : [TEST backend]×2, [TEST frontend], workflows CI.

Stratégie de test en couches : typecheck TypeScript strict + build (CI, bloquants) ; tests unitaires/intégration Vitest (backend : auth baseline, 6 suites Project Office, T&D ; frontend : rendu des pages, guards de nav, hooks de scope de cache) ; smoke tests API par phase rejouant les flux métier réels (devis→commande, réceptions, pack expédition, nomenclatures, GPAO B6 bout-en-bout) avec vérifications SQL ; E2E Playwright (partiel, génère aussi les captures documentaires via E2E_CAPTURE_DOCS=1).

La validation technique est industrialisée : la CI conditionne le merge et le déploiement prod (CA-DEV-01) ; les migrations ont leurs scripts verify ; les releases s'accompagnent de smoke prod (T&D : « smoke vert » tracé dans le rapport de release).

Limites honnêtes : couverture inégale sur les modules du pic 2026-02, E2E T&D bloqué par l'absence de backend cerp_test déployé, et pas encore de campagne de tests utilisateurs formelle (prévue jalon J11) [À compléter après recette pilote].`,
  },
  {
    section: "12.1", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Tests fonctionnels : smoke tests API par phase (phase2→13c, réceptions phase 9 + SQL, pack phase 6, nomenclature, gpao-b6-e2e.sh) — scénarios métier complets exécutables à la demande contre une base de validation.`,
  },
  {
    section: "12.2", status: "A_DOCUMENTER", progress: 10,
    notes: "Tests utilisateurs formels non réalisés — planifiés à la recette pilote (J11, 2026-09). Consigner comptes rendus + anomalies dans le module.",
    draft: `> BROUILLON_IA. [À compléter] Pas de campagne de tests utilisateurs formalisée à ce jour ; l'usage quotidien par l'alternant (lui-même utilisateur atelier) fait office de test continu mais sans traçabilité. La recette pilote J11 (2026-09) produira les preuves : sessions par service, anomalies consignées, corrections liées.`,
  },
  {
    section: "12.3", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Corrections tracées : fix conversion devis (PR back#14), CORS/sélecteur base (#17→#19), permissions storage Docker (#20/#21), 504 VPS (#25/#26), escalade register (#28), ws High runtime (#117), routing Project Office (#133). Chaque bug significatif = PR + test de non-régression quand pertinent.`,
  },
  {
    section: "12.4", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Validation technique : CI bloquante (typecheck+tests+build, CA-DEV-01), gate de déploiement prod, scripts verify SQL post-migration, smoke post-release (T&D prod), 6 suites de tests sécurité/accès sur Project Office (gate fail-closed, anti-IDOR, montage migrations).`,
  },

  // ============================================================ 13. Optimisation
  {
    section: "13", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA — à relire. Preuves : PRs web#93/#103/#117, back#26/#51.

Optimisations livrées en juillet 2026 après audit. Performance frontend : découpage des vendor chunks (5 Mo → 2,5 Mo, A5) et lazy-loading React.lazy des pages du dashboard — temps de premier affichage nettement réduit sur les postes atelier ; refactor du routage dashboard testé. Performance/robustesse backend : bornage des attentes PostgreSQL (connexion, statement, lock, idle-in-transaction) sous le timeout du reverse proxy pour éliminer les 504 opaques du VPS.

Sécurité comme qualité : rate-limit login, erreurs génériques, correction de la vulnérabilité runtime ws (High, CA-DEV-04) et de la vulnérabilité critique vitest (dev), SCA Dependabot activée avec overrides.

Nettoyage : restructuration du code auth (2026-01), conventions de couches appliquées aux modules récents, dette UI réduite par la vague A1-A6. Reste à faire tracé : tri des ~40 PRs Dependabot (action A04), refactors ciblés des modules 2026-02 (risques R02/R03).`,
  },
  {
    section: "13.1", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Code : restructuration auth centralisée (2026-01), refactor routage dashboard testé (PR #97), alignement des modules récents sur les conventions de couches, types partagés. Dette restante cartographiée dans les risques R02/R03.`,
  },
  {
    section: "13.2", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Performances : split vendor chunks 5→2,5 Mo (A5, PR #93), lazy-loading des pages (PR #103), timeouts DB bornés (PR back#26), pool PostgreSQL paramétré (max, idle, statement_timeout). Mesures avant/après consignées dans les PRs.`,
  },
  {
    section: "13.3", status: "BROUILLON_IA", progress: 60,
    draft: `> BROUILLON_IA. Nettoyage : suppression du snapshot backend local obsolète (ADR-0011), fix vulnérabilités dev (vitest critique), overrides npm assainis (P1.5), conventions de commit et lint. Chantier continu — tri Dependabot planifié (A04).`,
  },
  {
    section: "13.4", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. UX : vague A1-A6 complète (badges commande, code postal, totaux/remises, aide article→projet, perf ressentie, Réessayer), trois modes d'affichage des tables, écrans d'erreur actionnables. Retours pilotes à venir (J11) alimenteront la suite.`,
  },

  // ============================================================ 14. Préparation déploiement
  {
    section: "14", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA — à relire. Preuves : [DOC_SOURCE change-record], [DOC_SOURCE hosting], [BACKUP], workflows deploy.

Préparation au déploiement industrialisée : environnements séparés (cerp_test pour valider, cerp_prod pour servir), migrations additives idempotentes appliquées test d'abord avec scripts verify et rollback écrits à l'avance, sauvegardes pg_dump testées (cerp-pg-backup.sh → /var/backups/cerp, restauration éprouvée) exécutées avant toute opération sensible — y compris avant le peuplement du présent module (preuve [BACKUP] 2026-07-10).

Configuration serveur documentée : VPS Coolify (frontend + API web, TLS), HYPERBOX2 atelier (PostgreSQL, WireGuard), runbooks devops (hyperbox2-postgres, wireguard, rollback). Le durcissement du 2026-07-06 (backups + VPS) et la résolution de l'incident de connectivité du même jour ont validé la procédure en conditions réelles.

Tests en conditions réelles : smoke API contre la prod après chaque release (tracé pour T&D), vérification globale par la gate CI (CA-DEV-01) qui interdit un déploiement sans typecheck/tests/build verts.`,
  },
  {
    section: "14.1", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Serveurs : VPS Coolify (cerp.croix-rousse-precision.fr + erp-backend.croix-rousse-precision.fr), HYPERBOX2 atelier (PostgreSQL 5432 local + WireGuard 10.90.0.x, backend atelier /srv/cerp). Durcissement VPS 2026-07-06. Schéma réseau complet à consolider (action A01).`,
  },
  {
    section: "14.2", status: "BROUILLON_IA", progress: 80,
    draft: `> BROUILLON_IA. Base : parité de schéma test/prod contrôlée, patches Project Office appliqués sur les deux bases (verify OK), template rapport seedé, flag fail-closed en prod (pilote KEENAN seul), backup pré-peuplement réalisé et consigné.`,
  },
  {
    section: "14.3", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Conditions réelles : smoke prod post-release (T&D : « smoke vert » consigné), test de restauration de backup documenté (change-record 2026-07-06), incident WireGuard résolu et documenté — la procédure de crise a fonctionné.`,
  },
  {
    section: "14.4", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Vérification globale : gate CI avant prod (CA-DEV-01), checklist de release via PR dev→main, scripts verify SQL, revue de conformité post-release (ex. 13_post_b7 pour GPAO V2). Piste : formaliser une checklist de déploiement unique réutilisable.`,
  },

  // ============================================================ 15. Déploiement et démonstration
  {
    section: "15", status: "BROUILLON_IA", progress: 55,
    draft: `> BROUILLON_IA — à relire. Preuves : PRs release dev→main, [DEPLOYMENT] Coolify, rapports de release T&D.

CERP est déployé et utilisé : frontend web et API en production sur le VPS (Coolify) avec la base atelier, CERP Desktop sur les postes atelier, releases quasi quotidiennes en juillet 2026 via PRs dev→main (pas encore de tags versionnés — amélioration identifiée). Les vérifications post-déploiement sont tracées : smoke API prod, contrôles SQL, rapports de release (T&D, GPAO V2, Project Office).

Les modules récents suivent un déploiement « pilote » maîtrisé : Temps & Déplacements visible des seuls pilotes RH, Project Office gardé par feature flag fail-closed activé pour l'utilisateur pilote uniquement — le flag global reste désactivé en prod.

La présentation/démonstration finale reste à venir : scénario bout-en-bout (devis → commande → OF → livraison → facture + RH + pilotage) planifié pour le jalon J14 (2027-06), préparé par l'action A11. [À compléter après la démonstration : compte rendu + captures.]`,
  },
  {
    section: "15.1", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Mise en ligne : merges dev→main déclenchent le déploiement Coolify (gate CI) ; backend atelier mis à jour selon la procédure runbook ; CERP Desktop via flux de mise à jour dédié (ADR-0012 update feed). Releases de juillet 2026 : T&D (#74/#75, #128/#129), Project Office (#77, #132/#134).`,
  },
  {
    section: "15.2", status: "BROUILLON_IA", progress: 70,
    draft: `> BROUILLON_IA. Post-déploiement : smoke API prod consigné (T&D), vérification des migrations (verify SQL), contrôle du gate d'accès Project Office en prod (flag OFF global + pilote seul), surveillance des erreurs 5xx (bornage DB anti-504).`,
  },
  {
    section: "15.3", status: "A_DOCUMENTER", progress: 10,
    notes: "Présentation formelle non réalisée — jalon J14 (2027-06). Préparer supports + compte rendu.",
    draft: `> BROUILLON_IA. [À compléter] La présentation du projet (soutenance/démonstration devant direction et école) est planifiée au jalon J14 (2027-06-30, action A11). Les démonstrations réalisées à ce jour sont informelles (montrées au fil de l'eau en interne) et non tracées.`,
  },
  {
    section: "15.4", status: "A_DOCUMENTER", progress: 15,
    notes: "Démo scriptée bout-en-bout à construire (dépend stabilisation flux démo, issue #40).",
    draft: `> BROUILLON_IA. [À compléter] Démonstration fonctionnelle scriptée à construire sur le scénario devis→commande→OF→livraison→facture + pointage + pilotage (issue #40 « stabilisation des flux démo » ouverte). Sera jouée à J14 et enregistrée comme preuve.`,
  },

  // ============================================================ 16. Documentation et bilan
  {
    section: "16", status: "BROUILLON_IA", progress: 60,
    draft: `> BROUILLON_IA — à relire. Preuves : arborescence docs/ des 2 repos, [DOC_SOURCE iso], présent module.

Documentation technique riche et versionnée (docs-as-code) : 16 ADR, architecture (17 documents), devops/runbooks (14), sécurité + SMSI ISO 27001 (scope, SoA, registres, preuves), RGPD, API (Swagger + alignement front/back), base de données, CHANGELOG détaillé, AGENTS.md/INSTRUCTIONS_BACKEND.md pour l'ingénierie assistée. Documentation utilisateur en revanche embryonnaire (squelette docs/user-guide) — chantier EPIC-13 avec la formation.

Bilan à mi-parcours (2026-07) : 15 EPICs dont 3 DONE, 9 jalons atteints sur 16, ~30 modules en production, 141 PRs mergées, un pilotage désormais outillé dans l'ERP lui-même. Réussites : maîtrise complète du SI, traçabilité, industrialisation du process (PR+CI+preuves). Limites assumées : modules partiels (R04), recette utilisateur à faire (R09), dépendance à une personne (R01), couverture de tests inégale.

Perspectives 2027 : achats/GED/reporting, MES tablettes, CBN/CCBN, TRS, PIC/PDP (EPIC-14, décision D17), formation et passation (réduction de R01), audit interne ISO (J13), soutenance (J14) et release finale décembre 2027 (J15).`,
  },
  {
    section: "16.1", status: "BROUILLON_IA", progress: 75,
    draft: `> BROUILLON_IA. Documentation technique : ADR 0001→0014, docs/architecture (dont module Project Office), db/patches auto-documentés (verify/rollback), Swagger, runbooks devops, dossiers sécurité/conformité, cartes de repo (erp_system_map, frontend_repo_map). Gaps : backend sans README/CHANGELOG racine (à créer), collision ADR-0012 à résoudre (action A06).`,
  },
  {
    section: "16.2", status: "A_DOCUMENTER", progress: 10,
    notes: "docs/user-guide = squelette. Rédiger guides par module en commençant par T&D (RH) et commerce (EPIC-13, 2027-T1/T2).",
    draft: `> BROUILLON_IA. [À compléter] Documentation utilisateur quasi inexistante (squelette docs/user-guide/README.md). Plan : guides pas-à-pas par module, d'abord Temps & Déplacements (utilisateurs RH pilotes) puis commerce, adossés aux sessions de formation (LOT-13.1/13.2, 2027).`,
  },
  {
    section: "16.3", status: "BROUILLON_IA", progress: 55,
    draft: `> BROUILLON_IA. Bilan intermédiaire : objectifs V0 largement engagés (flux complet possible, traçabilité en place, CLIPPER toujours en parallèle), industrialisation du développement réussie (PR/CI/preuves depuis 2026-06), sécurité nettement durcie (CA-SEC, ISO). Écarts : recette utilisateur, modules partiels, formation. Bilan final à J14/J15. [À compléter en fin de projet.]`,
  },
  {
    section: "16.4", status: "BROUILLON_IA", progress: 65,
    draft: `> BROUILLON_IA. Perspectives : roadmap 2027 (achats, GED, reporting, MES, CBN/CCBN, TRS, PIC/PDP — EPIC-14), extinction progressive de CLIPPER, élargissement des utilisateurs après recette, passation documentée pour réduire la dépendance à une personne clé, certification ISO 27001 en option selon décision entreprise.`,
  },
];

/** Liaisons preuves ↔ sections (relation typée). */
export const REPORT_ENTRY_EVIDENCE: ReportEntryEvidenceDef[] = [
  { section: "1", evidenceTitle: "[DOC_SOURCE analyse] Analyse du contexte et des besoins (DOCX)", relation: "SOURCE" },
  { section: "1", evidenceTitle: "[DOC_SOURCE rapport] Rapport de projet CERP (PDF final)", relation: "SOURCE" },
  { section: "2", evidenceTitle: "[DOC_SOURCE genese] Rapport genèse ERP CRP (2026-06-16)", relation: "SOURCE" },
  { section: "2", evidenceTitle: "[DOC_SOURCE cdc] Cahier des charges ERP CRP consolidé v2.0 (74 Ko)", relation: "SOURCE" },
  { section: "3", evidenceTitle: "[DOC_SOURCE note-2026-06-25] Note métier du 25/06/2026 (DOCX)", relation: "SOURCE" },
  { section: "3", evidenceTitle: "[GITHUB_ISSUE web#119] Épique module Temps & Déplacements", relation: "SOURCE" },
  { section: "4", evidenceTitle: "[DOC_SOURCE hosting] Hébergement & accès base de données (backend)", relation: "ARCHITECTURE" },
  { section: "4", evidenceTitle: "[DOC_SOURCE incident] Incident connectivité WireGuard/DB (2026-07-06, résolu)", relation: "SOURCE" },
  { section: "4", evidenceTitle: "[DOC_SOURCE air-cyber] Grille Air Cyber (XLSX)", relation: "SECURITY" },
  { section: "5", evidenceTitle: "[DOC_SOURCE cdc] Cahier des charges ERP CRP consolidé v2.0 (74 Ko)", relation: "SOURCE" },
  { section: "5", evidenceTitle: "[DOC_SOURCE note-2026-06-25] Note métier du 25/06/2026 (DOCX)", relation: "SOURCE" },
  { section: "6", evidenceTitle: "[SCREENSHOT] Maquettes Pencil CERP (kit + écrans clés)", relation: "UI" },
  { section: "7", evidenceTitle: "[DOC_SOURCE adr] ADR-0014 Project Office / macro-planning (accepté 2026-07-10)", relation: "ARCHITECTURE" },
  { section: "7", evidenceTitle: "[MIGRATION 20260710] Schéma Project Office core (16 tables + flags)", relation: "ARCHITECTURE" },
  { section: "7", evidenceTitle: "[DOC_SOURCE pdm-sgdt] Exp-PDM-SGDT-4p (PDF)", relation: "SOURCE" },
  { section: "8", evidenceTitle: "[DOC_SOURCE gestion-projet] GESTION PROJET.xlsx (ancien pilotage manuel)", relation: "SOURCE" },
  { section: "8", evidenceTitle: "[GITHUB_ISSUE web#130] Épique module Project Office", relation: "SOURCE" },
  { section: "9", evidenceTitle: "[DOC_SOURCE hosting] Hébergement & accès base de données (backend)", relation: "ARCHITECTURE" },
  { section: "9", evidenceTitle: "[SCREENSHOT] GitKraken — graphe des 2 repos", relation: "SCREENSHOT" },
  { section: "9", evidenceTitle: "[GIT_COMMIT back c6fd108] Initial commit backend (2025-07-15)", relation: "SOURCE" },
  { section: "10", evidenceTitle: "[GIT_LOG 2026-02] Pic de développement cœur ERP (125 commits frontend)", relation: "SOURCE" },
  { section: "10", evidenceTitle: "[GITHUB_PR back#31] CA-APP-01 — recalcul serveur des totaux devis", relation: "FIX" },
  { section: "10", evidenceTitle: "[GITHUB_PR back#59] PDM V2 — cœur (versions/indices, achats typés, lien article)", relation: "SOURCE" },
  { section: "11", evidenceTitle: "[GITHUB_PR back#69] T&D T7 — exports paie figés + checksum", relation: "SOURCE" },
  { section: "11", evidenceTitle: "[GITHUB_PR back#76] Project Office backend complet (~45 endpoints, DOCX)", relation: "SOURCE" },
  { section: "11", evidenceTitle: "[GITHUB_PR web#85] UI commande 3 types — badges, résumé (A1)", relation: "UI" },
  { section: "12", evidenceTitle: "[TEST backend] Suites Vitest Project Office (accès, cœur, rapport, sécurité)", relation: "TEST" },
  { section: "12", evidenceTitle: "[TEST backend] Smoke tests API par phase (phase2→13c, réceptions, nomenclature)", relation: "TEST" },
  { section: "12", evidenceTitle: "[TEST frontend] Tests pages/guards Project Office + garde nav", relation: "TEST" },
  { section: "13", evidenceTitle: "[GITHUB_PR web#93] Perf — split vendor chunks 5→2,5 Mo (A5)", relation: "FIX" },
  { section: "13", evidenceTitle: "[GITHUB_PR web#117] CA-DEV-04 — fix ws (High runtime) + patches build", relation: "SECURITY" },
  { section: "14", evidenceTitle: "[DOC_SOURCE change-record] Backups & durcissement VPS (2026-07-06)", relation: "DEPLOYMENT" },
  { section: "14", evidenceTitle: "[BACKUP] Sauvegarde cerp_prod avant peuplement Project Office (2026-07-10)", relation: "DEPLOYMENT" },
  { section: "15", evidenceTitle: "[DEPLOYMENT] Frontend cerp.croix-rousse-precision.fr + backend erp-backend (Coolify VPS)", relation: "DEPLOYMENT" },
  { section: "15", evidenceTitle: "[GITHUB_PR back#75] T&D — release main/prod pilote (smoke vert)", relation: "DEPLOYMENT" },
  { section: "15", evidenceTitle: "[MODULE_ANALYSIS] Écran Project Office vide avant peuplement (prod)", relation: "SCREENSHOT" },
  { section: "16", evidenceTitle: "[DOC_SOURCE iso] Dossier SMSI compliance/iso27001 (scope, SoA, registres)", relation: "SOURCE" },
  { section: "16", evidenceTitle: "[DOC_SOURCE t&d] Rapports finaux Temps & Déplacements (T11 + release prod)", relation: "SOURCE" },
  { section: "16", evidenceTitle: "[DOC_SOURCE user-guide] Squelette guide utilisateur (docs/user-guide)", relation: "SOURCE" },
];

/** Versions du rapport (V0 import → V4 cible finale). */
export const REPORT_VERSIONS: ReportVersionDef[] = [
  {
    version: "V0", title: "V0 — Import de l'ancien rapport (PDF)",
    snapshot: { source: "Rapport_Projet_CERP_Keenan_MARTIN_Final.pdf", type: "import", note: "Rapport existant conservé tel quel comme point de départ ; preuve [DOC_SOURCE rapport]." },
    markdown: `# Rapport de projet CERP — V0 (import)\n\nVersion de référence : le rapport PDF existant (Desktop/Rapport_CERP_Final/Rapport_Projet_CERP_Keenan_MARTIN_Final.pdf), rédigé avant la création du module Project Office. Il sert de socle aux sections 1→9 ; ses limites marquées [À vérifier]/[Source manquante] sont reprises comme points À_DOCUMENTER dans les entrées du module.`,
  },
  {
    version: "V1", title: "V1 — Reconstruction depuis les preuves des repos",
    snapshot: { basis: "git log (391+315 commits), 141 PRs mergées, docs repo", generatedAt: "2026-07-10" },
    markdown: `# Rapport de projet CERP — V1 (preuves repos)\n\nReconstruction factuelle depuis Git/GitHub : chronologie réelle (2025-07-15 → 2026-07-10), modules par période, PRs structurantes, registres (décisions/risques) alignés sur les preuves. Cette version corrige la dérive « récit vs réel » de V0.`,
  },
  {
    version: "V2", title: "V2 — Rapport structuré Project Office (courante)",
    snapshot: { entries: 80, status: "BROUILLON_IA majoritaire", evidenceLinked: true, note: "Sections remplies par brouillons IA sourcés ; manques marqués A_DOCUMENTER." },
    markdown: `# Rapport de projet CERP — V2 (structuré module)\n\nVersion courante : les 16 sections × 4 sous-parties vivent dans le module, chaque section liée à ses preuves (PR, tests, docs, captures). Statuts honnêtes : BROUILLON_IA à relire, A_DOCUMENTER quand la preuve manque (personas, tests utilisateurs, présentation, doc utilisateur).`,
  },
  {
    version: "V3", title: "V3 — Version cible soutenance (planifiée)",
    snapshot: { target: "2027-06", milestone: "J14", todo: ["valider toutes les sections", "captures démo", "personas", "tests utilisateurs J11", "bilan final"] },
  },
  {
    version: "V4", title: "V4 — Version finale décembre 2027 (planifiée)",
    snapshot: { target: "2027-12", milestone: "J15", note: "Intègre le bilan de la release finale et la passation." },
  },
];
