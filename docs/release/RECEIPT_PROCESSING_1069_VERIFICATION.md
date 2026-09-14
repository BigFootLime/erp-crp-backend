# Vérification locale — Réception et emballage #1069

Date : 14 septembre 2026. Branche : `feature/1069-reception-packaging`. Référence métier : issue `BigFootLime/crp-systems-web#1069`, CERP/WP-256. Les résultats ci-dessous ne valent ni déploiement ni acceptation atelier.

## Serveur et contrats

- `npm run build` : compilation, contrat OpenAPI et frontière des données de production réussis. Inventaire : 1 325 opérations couvertes, empreinte source `66dffb4e72f3`.
- `node node_modules/vitest/vitest.mjs run src/__tests__/openapi-contract-sol28.test.ts src/module/receptions src/module/stock src/module/qualite src/module/production/repository/of-material-receipts.repository.test.ts` : **194 tests réussis**, 18 exclus. Parmi les exclus, les 14 tests PostgreSQL ci-dessous sont exécutés séparément ; les quatre anciens tests Qualité à schéma réduit ne sont pas exécutés dans la base complète.
- Les tests couvrent notamment les quantités partielles, le transfert des besoins OF vers les portions MP sans augmentation du besoin, l’héritage borné des preuves qualité, les parcours consommables et les règles clients/CRP.
- Vérification complémentaire : **599 tests réussis** sur les 11 fichiers `article-unit-stock-contract`, `stock.historical-imports.routes`, `surface-finish-210.routes`, `surface-finish-244.family-comment`, `qualite-360-228.routes`, `qualite-360-228.domain`, `stock.routes`, `article-piece-link`, `article-master-data-164`, `article-category-primary-401` et `article-164-remaining-rules` sous `src/__tests__/`. Les fixtures SQL ont été complétées avec les champs commerciaux ; les deux fichiers concernés ont été rejoués avec succès après correction. La création rapide depuis une commande et la création d’une référence OLD transmettent explicitement leur client connu.
- Le lint ciblé des nouveaux composants web et du scénario visuel passe. Les contrôles `documentation:check`, `docs:check`, `architecture:check` et `security:secrets` du frontend passent.

## Base PostgreSQL dédiée

Base locale `cerp_1069_test`, créée par copie de schéma uniquement, sans données utilisateur. Des fixtures synthétiques créent leurs propres articles, commandes, lots, acteurs, documents et contrôles. Ne pas lancer ce scénario sur une base opérationnelle.

Le schéma préalable reprend les dépendances nécessaires. Deux migrations étrangères au périmètre imposant un autre nom de base ont refusé cette base dédiée et n’ont pas été forcées. La migration #1069 a été appliquée et rejouée avec `psql -v ON_ERROR_STOP=1`, puis ses scripts `preflight` et `verify` ont réussi. Le runner canonique a été exécuté **en simulation**, vérifiant sélection et empreinte ; l’application réelle avec ce runner reste à répéter dans la procédure de mise en service. Le registre de migrations de la copie de schéma est vide : son nombre de patches annoncés en attente ne décrit pas une base de production.

Patch : `20260914_receipt_processing_1069.sql`, SHA-256 canonique LF : `72e3665019f649c8cbf9c9b919973bad7e046b37529c37313b88dd6f1f0721b2`. Dépendances et fichiers de support enregistrés dans l’inventaire canonique. Les lacunes préexistantes de support d’autres patches ne sont pas présentées comme corrigées.

Avec `DATABASE_URL` fourni de façon privée vers cette base :

```sh
node scripts/e2e/receipt-processing-1069.js
```

**14 tests réussis**, sur vraies transactions PostgreSQL :

1. Politique pièces forcée, aucun stock après réception physique.
2. Contrôle seul insuffisant ; 100/60/50, refus de dépassement, entrée MP, généalogie et rejeu sans doublon.
3. Deux emballages concurrents : aucun dépassement des quantités acceptées.
4. Deux entrées concurrentes : aucun dépassement des quantités emballées.
5. Entrée manuelle sur le lot reçu refusée par le service commun.
6. Publication SQL avant insertion des lignes bloquée par la contrainte différée.
7. Contrôle dégradé après emballage : stock refusé.
8. BL altéré : emballage refusé.
9. BL mixte avec consommable terminé et pièce encore ouverte ; clôture refusée.
10. Outillage reçu une seule fois dans le registre outils, sans mouvement article.
11. Article multi-clients, mode CRP et contraintes de cohérence.
12. Retour sous-traitant lié à OF, opération et lot expédié, puis entrée MP.
13. Réemploi d’un RETURN existant sans doubler la garde physique.
14. Retour/rebut avant stock lié à la NC, quantité supplémentaire refusée, libération ultérieure bornée, clôture conditionnée aux écarts fermés.

Les contrôles valides sont amorcés pour éprouver les transactions d’emballage et de stock. Les mesures, rôles et décisions de l’interface Qualité doivent aussi être recettés via HTTP avec des comptes réels. Les nouveaux fichiers temporaires de BL sont supprimés après les tests ; les fixtures restent dans la base dédiée et portent leurs références de test.

## Interfaces et acceptation restante

Web : build et typage réussis ; 127 tests ciblés Réceptions, création d’article, détail et catalogue réussis, ainsi que les 5 tests du registre documentaire. Les contrôles documentation, architecture et secrets passent. Inspection navigateur des composants réels sur adaptateur fictif, avec BL mixte et tentative 51 corrigée à 50. Cet essai n’est pas un parcours HTTP authentifié complet.

Android : typage, 13 tests du socle et APK interne ARM64 compilé, avec modules PDF et scanner. Les écrans ajoutés n’ont pas été essayés sur tablette physique : l’utilisateur a confirmé son indisponibilité. Voir `docs/reception-1069.md` du dépôt mobile pour l’artefact et sa signature interne.

À exécuter avant acceptation : répétition opérationnelle de migration et qualification des réceptions ouvertes ; parcours complet avec rôles réels, documents/antivirus et imprimante ; essais tablette caméra, scanners USB/Bluetooth, PDF, double confirmation, coupure réseau et changement d’opérateur. Les corrections historiques ne sont pas appliquées automatiquement. Aucune migration de production ni publication n’a été faite. Project Office non synchronisé faute d’accès.
