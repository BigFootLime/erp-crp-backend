import type { SpecVersionDef } from "../types";

/**
 * Cahier des charges fonctionnel CERP — 5 versions.
 * V0/V1/V2 approuvées (preuves fortes), V3 en relecture, V4 = roadmap non livrée.
 */
export const SPEC_VERSIONS: SpecVersionDef[] = [
  {
    version: "V0",
    changeSummary: "Cadrage initial : besoin métier, limites CLIPPER 07, objectifs. Sources : Analyse du contexte et des besoins (DOCX), rapport de projet §1-§2. Dates de cadrage antérieures au premier commit : à valider.",
    approvedAt: "2025-07-15T09:00:00+02:00",
    content: `# Cahier des charges fonctionnel CERP — V0 (cadrage initial)

> Statut : APPROUVÉ (référence historique) · Période : juin-juillet 2025
> Sources : DOC_SOURCE « Analyse du contexte et des besoins.docx », rapport de projet §1-§2, rapport genèse.

## 1. Contexte
Croix Rousse Précision (CRP) est un atelier d'usinage de précision. La gestion repose sur
CLIPPER 07 : logiciel vieillissant, interface datée, saisies redondantes, traçabilité
difficile, dépendance à l'éditeur. Les fichiers Excel périphériques (gestion de projet,
codification) complètent CLIPPER au prix d'une double saisie.

## 2. Problème à résoudre
- Perte de temps : ressaisies entre devis, commandes, OF et livraisons.
- Traçabilité insuffisante : difficile de relier pièce ↔ lot ↔ OF ↔ livraison.
- Rigidité : CLIPPER impose ses flux, l'atelier adapte ses process au logiciel.
- Donnée enfermée : pas d'accès simple à la donnée pour l'analyser ou l'automatiser.

## 3. Objectifs
1. Remplacer progressivement CLIPPER 07 par un ERP interne : CERP.
2. Centraliser les flux métier (commerce → production → livraison → facturation).
3. Améliorer la traçabilité (lots, indices de plans, généalogie).
4. Moderniser l'interface (simple, rapide, sans « usine à gaz »).
5. Garder la maîtrise interne du système d'information (code + données).

## 4. Utilisateurs cibles
Production (opérateurs, responsables d'atelier), gestion/administration (devis, commandes,
factures), qualité, direction. Plus tard : RH (pointage) et pilotage projet.

## 5. Périmètre V0 (intention)
Modules à terme : clients, devis, commandes, articles, production/OF, stock, livraisons,
qualité, outillage. Démarrage par les référentiels et le flux commercial.

## 6. Hors périmètre V0
Paie (export seulement), comptabilité générale (facturation seulement), MES temps réel,
calcul des besoins (CBN), certification ISO (conformité visée, pas la certification).

## 7. Contraintes
- Équipe : un développeur (alternant), encadré côté entreprise.
- Coût : pas de licences ; infrastructure existante (serveur atelier).
- Continuité : CLIPPER reste en service pendant la transition.
- Confidentialité : données clients/production sensibles, hébergement interne.

## 8. Critères d'acceptation (globaux)
- Un flux complet devis → commande → OF → livraison → facture réalisable dans CERP.
- Toute pièce livrée traçable (article, indice, lot, OF).
- Les utilisateurs métier réalisent leurs tâches sans revenir à CLIPPER sur les modules basculés.

## 9. Risques identifiés à ce stade
Dépendance à une personne clé, ambition du périmètre, adoption utilisateurs, reprise des
données CLIPPER. (Repris et suivis dans le registre des risques du Project Office.)

## 10. Preuves liées
Preuves [DOC_SOURCE analyse], [DOC_SOURCE rapport], [DOC_SOURCE genese] dans le registre des preuves.`,
  },
  {
    version: "V1",
    changeSummary: "Architecture ERP modulaire : choix techniques actés (monolithe modulaire, React/Vite/TS, Express/Zod, PostgreSQL, Coolify, GitHub Actions, RBAC/audit). Sources : ADR 0001→0011, README, repos.",
    approvedAt: "2026-06-16T18:00:00+02:00",
    content: `# Cahier des charges fonctionnel CERP — V1 (architecture ERP modulaire)

> Statut : APPROUVÉ · Période : 2025-07 → 2026-06 (formalisé le 2026-06-16 via les ADR)
> Sources : docs/adr/0001→0011, docs/architecture/*, README des 2 repos.

## 1. Contexte
V0 a validé le besoin ; V1 fixe l'architecture qui porte le développement depuis juillet 2025.

## 2. Décisions d'architecture (ADR)
- **Monolithe modulaire** (ADR-0001) : un backend, des modules métier isolés (src/module/*).
- **Frontend React + Vite + TypeScript** (ADR-0002), UI shadcn/tailwind ; client desktop Electron.
- **PostgreSQL** source de vérité (ADR-0003), patches SQL additifs versionnés (db/patches).
- **Backend Express + TypeScript + Zod**, SQL manuscrit, couches routes→controllers→services→repository.
- **Coolify** pour le déploiement web (ADR-0006), **GitHub Actions** pour la CI (ADR-0007).
- **RBAC + audit logs** (ADR-0008), **outbox transactionnel** pour les événements (ADR-0009).
- **Docs-as-code** (ADR-0010) : ADR, CHANGELOG, docs/ dans le repo.

## 3. Topologie
- Backend API \`/api/v1\` (Express) + Socket.IO temps réel + Swagger.
- Frontend web (VPS Coolify) : cerp.croix-rousse-precision.fr → erp-backend.croix-rousse-precision.fr.
- Base de données sur le serveur atelier HYPERBOX2, jointe par WireGuard depuis le VPS.
- CERP Desktop (Electron) en local-first atelier avec sélection d'API.
- Deux bases : cerp_prod (vérité) / cerp_test (validation).

## 4. Règles transverses
- JWT obligatoire (default-deny), bcrypt, rôles applicatifs.
- Validation Zod à l'entrée, backend autoritaire sur les règles métier.
- Migrations : patch additif + verify + rollback, cerp_test d'abord.
- Branches : feature/* → dev (intégration) → main (stable déployé).

## 5. Critères d'acceptation
- CI verte obligatoire (typecheck, tests, build) avant merge.
- Chaque module nouveau suit la structure de couches et fournit ses tests.
- Aucune migration destructive sans backup + rollback écrit.

## 6. Preuves liées
[DOC_SOURCE adr] ADR-0014 et dossier docs/adr, [MIGRATION] db/patches, repos GitHub.`,
  },
  {
    version: "V2",
    changeSummary: "Socle commercial / production / stock / qualité livré : périmètre détaillé par module tel qu'implémenté (2025-07 → 2026-03), consolidé dans le CDC docs-as-code v2.0 du 2026-07-03.",
    approvedAt: "2026-07-03T18:00:00+02:00",
    content: `# Cahier des charges fonctionnel CERP — V2 (socle métier livré)

> Statut : APPROUVÉ · Période couverte : 2025-07 → 2026-06 · Consolidé le 2026-07-03
> Sources : docs/cahier-des-charges-erp-crp.md (v2.0, 74 Ko), git log, PRs, modules livrés.

## 1. Contexte
Le socle métier est développé (pic février 2026 : 125 commits front / 54 back). V2 fige le
périmètre réellement livré et les règles métier observées.

## 2. Modules livrés (périmètre V2)
### Commerce
- **Clients** : fiche, contacts, adresses, codes, modes de paiement, niveaux qualité, analytics.
- **Devis** : formulaire + dashboard, totaux calculés serveur (CA-APP-01), statuts canoniques
  avec CHECK en base (CA-APP-02), remises, conversion en commande.
- **Commandes clients** : trois types — FERME (fermée), CADRE (ouverte avec appels de
  livraison), INTERNE ; AR ; liens affaires ; allocations.
- **Affaires** : type livraison | projet ; un article fabriqué exige une affaire projet.
- **Facturation** : factures et documents associés (avoirs/paiements à compléter).

### Production
- **Planning atelier** : machines/postes, charge.
- **OF** : parent/enfant, arborescence de fabrication récursive, snapshot de structure à la
  création, référence article + indice (ADR-0012).
- **Dossiers d'opération** : gammes, opérations (tournage/fraisage/reprise).

### Logistique
- **Stock** : articles avec versioning, début matière ; magasins/emplacements/lots partiels.
- **Réceptions fournisseur** : avec contrôle réception (phase 9).
- **Livraisons** : BL, allocations stock, pack documentaire d'expédition (phase 6).
- **Outillage** : sorties, panier, inventaire, fiches fabricants/fournisseurs/outils/revêtements.

### Qualité
- **Qualité** : dispositions, KPI, lots. **Métrologie** : moyens de mesure (base).
- **Traçabilité** : généalogie de lots. **As-built**.

### Transverse
- Auth JWT + sélecteur base prod/test (X-CERP-Database applicatif), utilisateurs/rôles,
  notifications, chat interne temps réel, verrous d'édition, audit logs append-only.

## 3. Règles métier clés
- Totaux et statuts = serveur uniquement ; le front affiche ce que l'API confirme.
- OF : la structure est figée au lancement (snapshot) ; les référentiels évoluent sans
  corrompre l'historique.
- Commande CADRE : les livraisons se font par appels rattachés à la commande ouverte.
- Traçabilité : chaque livraison relie article/indice/lot/OF.

## 4. Hors périmètre V2
Achats/fournisseurs complets, GED, MES, CBN/CCBN, TRS, PIC/PDP, paie (exports seulement),
comptabilité générale.

## 5. Critères d'acceptation
Smoke tests par phase verts (phase2→13c), flux devis→commande→OF→BL→facture démontrable,
contraintes DB actives (CHECK statuts, FK).

## 6. Preuves liées
[DOC_SOURCE cdc] CDC v2.0, [GIT_LOG 2026-02], PRs CA-APP-01/02, smoke tests.`,
  },
  {
    version: "V3",
    changeSummary: "Données techniques / GPAO V2 / Project Office : versions & indices de pièces (PDM), nomenclatures fabrication vs achat, exigences de la note du 25/06, module de pilotage. En relecture.",
    content: `# Cahier des charges fonctionnel CERP — V3 (données techniques, GPAO V2, pilotage)

> Statut : EN RELECTURE · Période couverte : 2026-06 → 2026-07 (+ exigences note du 25/06)
> Sources : DOC_SOURCE note du 25/06, Exp-PDM-SGDT-4p.pdf, PRs #57/#59/#60/#115, ADR-0012/0013/0014, module Project Office.

## 1. Contexte
Après le socle V2, l'enjeu devient la **maîtrise des données techniques** (esprit PDM/SGDT)
et le **pilotage** : versions/indices, séparation des objets, planning fiable, et un module
de pilotage qui remplace les fichiers Excel de gestion de projet.

## 2. Exigences données techniques (livrées 2026-07, B7)
- Séparation stricte : article commercial / pièce technique / nomenclature / gamme / OF (D13).
- **Pièce technique** : versions et indices, plan_reference, cycle d'évolution ;
  interchangeabilité pilotée par l'indice (référence : Exp-PDM-SGDT).
- **Nomenclatures** : fabrication (arborescence récursive, base des OF) distincte de la
  nomenclature d'achat ; snapshot côté OF.
- **Gammes** : opérations typées tournage/fraisage/reprise, rattachées aux versions.
- **Achats typés** sur nomenclature (matière, composant, sous-traitance).
- **UI Données techniques** : versions, arborescence, achats, gammes (PR #115).

## 3. Exigences de la note du 25/06 (à planifier — reprises en EPIC-05/08/14)
- Base article : rang d'application / version d'application.
- Pièces cyclées ; figer le planning ; retard réel ; vision sous-traitance.
- OF avec référence article + indice (fait) ; documents qualité liés aux OF/livraisons.
- Machines : KPI maintenance ; moyens de mesure (étalonnages).
- Architecture stockage documentaire (GED), web/local.
- Briques 2027 : MES (tablettes), CBN, CCBN, TRS, PIC, PDP.

## 4. Exigences RH (livrées : module Temps & Déplacements)
Pointage append-only (35h/39h), corrections validées, kilomètres, exports paie figés
(CSV/PDF + checksum), bornes kiosk HID + badges. (ADR-0013, PRs #64→#75.)

## 5. Exigences pilotage (livrées : module Project Office)
- Macro-planning hiérarchique (EPIC/LOT/TASK), Gantt, Kanban, jalons, dépendances.
- Cahier des charges **versionné** (ce document), registre de décisions, registre de risques
  (probabilité×impact), actions correctives, **preuves** typées (PR/commit/test/capture/backup).
- Rapport Bac+5 : 16 sections × 4 sous-parties, brouillons IA **toujours** liés aux preuves
  (D15/D16), exports DOCX/MD avec checksum.
- Sécurité : flag PROJECT_OFFICE fail-closed, pilote par utilisateur, anti-IDOR.

## 6. Critères d'acceptation V3
- Une évolution d'indice de pièce n'altère aucun OF lancé (snapshot vérifié).
- Le pilotage projet (tâches, jalons, risques, preuves) vit dans CERP, plus dans Excel.
- Le rapport exporté (DOCX) reflète uniquement des faits sourcés.

## 7. Hors périmètre V3
MES exécution, CBN/CCBN, TRS, PIC/PDP (V4/roadmap) ; certification ISO.

## 8. Preuves liées
[DOC_SOURCE note-2026-06-25], [DOC_SOURCE pdm-sgdt], [GITHUB_PR back#59], [GITHUB_PR web#115],
[DOC_SOURCE b6b7], [GITHUB_PR back#76], [DOC_SOURCE adr] ADR-0014.`,
  },
  {
    version: "V4",
    changeSummary: "Version cible décembre 2027 (ROADMAP, non livrée) : achats, GED, reporting, MES, CBN/CCBN, TRS, PIC/PDP, formation, audit. Aucun engagement — périmètre arbitré trimestre par trimestre.",
    content: `# Cahier des charges fonctionnel CERP — V4 (cible décembre 2027 — ROADMAP)

> Statut : BROUILLON / ROADMAP — **non livré, non engagé**
> Horizon : 2027-01 → 2027-12 (jalon J15 : release décembre 2027)
> Sources : note du 25/06, macro-planning EPIC-13/14. Marquage : À PLANIFIER.

## 1. Intention
À fin 2027, CERP couvre le cycle complet de l'atelier, CLIPPER 07 n'est plus nécessaire au
quotidien, et les briques d'industrialisation (MES, calcul des besoins, indicateurs) sont
posées selon les arbitrages trimestriels.

## 2. Périmètre cible (par trimestre indicatif)
- **2027-T1** : fournisseurs & achats (commandes fournisseur, AR, relances) ; GED technique
  (plans + indices + diffusion) ; audit interne ISO (J13) ; complétion stock.
- **2027-T2** : reporting transverse ; début MES (tablettes atelier : démarrage/fin
  d'opération, quantités, aléas) ; formation des services ; démonstration finale (J14).
- **2027-T3** : MES consolidé ; CBN/CCBN sur nomenclatures + stock + carnet ; TRS machines.
- **2027-T4** : PIC/PDP ; gel du périmètre ; stabilisation ; release décembre 2027 (J15).

## 3. Pré-requis (dépendances explicites du macro-planning)
MES ← planning atelier fiabilisé ; CBN ← magasins/mouvements complets + nomenclatures ;
TRS ← MES ; PIC/PDP ← CBN. Formation ← guides utilisateur (EPIC-13).

## 4. Critères d'acceptation V4 (à confirmer)
- Un calcul CBN reproductible sur un périmètre pilote d'articles.
- Déclarations MES utilisées en production sur au moins un îlot.
- Bilan projet + rapport final soutenu ; passation documentée (réduction du risque R01).

## 5. Hors périmètre définitif (sauf décision nouvelle)
Comptabilité générale, paie interne (exports uniquement), e-commerce.

## 6. Avertissement
Cette version décrit une **cible**. Rien ici ne doit être présenté comme réalisé ; les
statuts font foi dans le macro-planning (BACKLOG/À PLANIFIER).`,
  },
];
