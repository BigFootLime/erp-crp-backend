# Préparation Production et regroupements — exploitation #712

Propriétaire : exploitation CERP. Dernière vérification locale : 2026-09-05.

## Précontrôles

Confirmer le couple de versions frontend/backend et la base cible. Les cinq patches du 5 septembre sont une seule livraison ; les appliquer dans l'ordre lexical après les migrations existantes, avec le runner canonique `scripts/db-patches.js`. Ne jamais modifier les checksums des anciennes migrations. L'environnement isolé de recette est PostgreSQL 18 sur boucle locale, port 55432, base `cerp_test` ; il n'est pas la production.

Avant production : disposer de la sauvegarde chiffrée et de sa preuve de restauration selon le runbook existant, vérifier les droits du rôle applicatif, GED privée, scanner, audit/outbox et compatibilité des versions servies. La sauvegarde de production n'a pas été effectuée dans ce chantier local.

Exécuter `db/patches/support/20260905_production_preparation_consolidation.preflight.sql` en lecture seule et consulter l'inventaire/statut des migrations. Observer les OF brouillons sans indice, achats sans révision, structures ambiguës et dates historiques ; ne pas leur attribuer des preuves arbitraires.

## Application

Patches, dans cet ordre :

1. `20260905_production_preparation_consolidation.sql` : preuves, achats par indice, priorité, allocations, protections.
2. `20260905_production_preparation_consolidation_02.sql` : programmation, réemploi, transferts, protection de l'exécution.
3. `20260905_production_preparation_consolidation_03.sql` : sous-OF de surplus, compatibilité enum et fiche liée à la quantité.
4. `20260905_production_preparation_consolidation_04.sql` : contrôle différé de conservation, adapté à chacune des tables.
5. `20260905_production_preparation_consolidation_05_grants.sql` : droits applicatifs minimaux, y compris les lectures des triggers ; aucune attribution globale ni changement des tables d’audit historiques.

Utiliser le dry-run et le filtre `--only` du runner canonique pour chacun, puis appliquer après la validation de livraison. Les opérations ALTER/TRIGGER nécessitent une fenêtre sans écritures concurrentes de production jusqu’à application des cinq patches et vérification des droits. Chaque sélection est enregistrée avec son empreinte LF immuable ; le runner valide tout l’inventaire avant toute application. Utiliser PostgreSQL peer auth sur HYPERBOX2. Les scripts `scripts/e2e/*isolated*` et le contrat historique de fixture ne doivent jamais être utilisés sur une base métier.

Exécuter ensuite `db/patches/support/20260905_production_preparation_consolidation.verify.sql`. Déployer le backend compatible avant le frontend ; les deux flags sont créés désactivés.

## Activation progressive

Dans les réglages administratifs existants des fonctionnalités, activer `PRODUCTION_WORKBENCH` sur l'environnement de recette. Tester un OF simple, un assemblage incomplet et une pièce sans TR/sous-traitance. Vérifier uploads propres, plan publié, fiche vierge téléchargeable et droits lecture/préparation/validation avec des comptes distincts.

Activer ensuite `PRODUCTION_CONSOLIDATION`. Préparer deux OF compatibles, ajouter un surplus, contrôler charge/allocations, planifier uniquement le producteur puis exécuter une réception partielle et une libération qualité. Vérifier composants de deux parents, réservation des bonnes demandes, surplus non réservé et absence de nouveaux AR/BL automatiques.

Après validation humaine de ces contrôles sur l'environnement de livraison, reproduire la procédure dans la fenêtre approuvée. Aucun flag de production n'a été modifié par ce chantier.

## Observation

Consulter `of_preparation_evaluations` (âge, empreinte, ready), `of_self_inspection_sheets` (FAILED/error_code), le journal d'audit des actions `production.preparation.*` et les tables `production_consolidation_*`. Les 409 de concurrence doivent inviter à recharger, jamais déclencher une écriture forcée. Les notifications de changement utilisent l'outbox existante ; l'écran réinterroge aussi le serveur toutes les 30 secondes et au seuil de priorité.

Mesurer liste/préparation sur les volumes réels avant activation générale : cibles proposées 800 ms et 1 s p95. Ces seuils ne sont pas des mesures obtenues sur la fixture locale. Contrôler le coût des compteurs et les plans SQL avec plusieurs milliers d'OF, sans données personnelles dans les preuves.

## Retour fonctionnel

Exécuter le script support `.rollback.sql` après décision d'exploitation : il désactive seulement les deux flags, sans supprimer table, fiche, allocation ou audit. Les OF déjà soumis aux règles et les regroupements existants restent consultables et protégés. Le traitement de ces OF exige un backend compatible ; ne pas revenir à une version ignorant les allocations actives.

Dissoudre un groupe seulement depuis l'API métier, avant planning/exécution/réception, avec motif et version attendue. Après engagement, conserver le producteur et traiter l'écart par les workflows de correction existants. Ne pas désactiver les triggers et ne pas réécrire les affectations.

## Reproduire les preuves locales

Les tests de règles utilisent `pnpm test:run`. Le test `src/module/production/repository/production-workbench.integration.test.ts` ne s'active qu'avec `CERP_E2E_ISOLATED=1` et l'URL exacte de la fixture locale. Il crée des données synthétiques exclusivement. Ne pas activer ces variables pour la suite entière : d'autres fixtures historiques possèdent leur propre contrat d'isolation.

Le helper `production-workbench-runtime.cjs` prépare le compte synthétique, démarre API/Vite en boucle locale puis lance le spec Playwright du frontend. Ses identifiants temporaires résident hors des dépôts, dans le dossier de runtime isolé. Ne jamais les versionner ou les publier.
