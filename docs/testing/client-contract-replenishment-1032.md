# Réapprovisionnement des contrats — lots fixes

Tâche Project Office : WP-286 / FLUX-20261009-05. Chantier parent : #1032.

Le calcul prend les manques mensuels nets issus de la couverture autoritaire existante. Il applique la taille de lot définie sur la ligne du contrat, avec arithmétique décimale exacte. Le surplus proposé couvre les mois suivants une seule fois ; il ne devient ni stock physique ni réservation. Les articles, indices, unités et sources Qualité/Planning restent ceux du calcul de couverture.

Cas vérifiés par les tests ciblés :

- manque 95, lot 40 : trois lots, quantité 120, surplus 25 ;
- manques 17 / 28 / 5, lot 20 : 1 / 2 / 0 lots, total 60 et surplus final 10 ;
- mois entièrement couverts, surplus conservé à travers un mois sans manque ;
- frontières décimales exactes, résultats déterministes et données sources inchangées ;
- lots de contrats distincts séparés, taille nulle/négative et chronologie invalide refusées ;
- cible historique du 30 septembre conservée avec retard au 10 octobre.

La réponse GET coverage expose `replenishment_projection` pour chaque ligne. OpenAPI décrit les quantités et le nombre entier de lots sous forme de chaînes, sans conversion flottante dans le moteur. L’endpoint reste en lecture seule et ne génère aucun OF. Il n’ajoute aucune migration.

La persistance des propositions, leurs états/idempotence, la génération via le moteur récursif canonique et la première date réalisable restent les étapes suivantes de #1032. Les appels CADRE historiques non rapprochés gardent leur refus explicite. La recette commune S04 ne sera complète qu’après ces étapes et leur rejeu réel.

Préparation de la persistance : `readClientContractCoverageTx` relit les mêmes demandes, sources et allocations dans la connexion fournie par le propriétaire de la transaction. La façade publique garde sa transaction `REPEATABLE READ READ ONLY`, son commit/rollback et sa libération de connexion. Les allocations des autres contrats restent internes et ne sont pas exposées par l’API. Quatre tests ciblés vérifient le budget partagé une seule fois, l’absence de seconde connexion/transaction et le traitement des erreurs par le bon propriétaire. Cette extraction ne crée encore aucune proposition persistée ni aucun OF.
# Préparations persistantes — lot en cours, non déployé

Le lancement des préparations persistées a maintenant un point d’entrée Production : `POST /production/clients/:clientId/contracts/:contractId/replenishment/commands`, avec `Idempotency-Key`, `action: GENERATE`, `plan_id` et `proposal_ids`. La sélection ne contient aucune quantité saisissable. La capacité de génération OF, la version courante, les intentions partagées, les preuves immuables et la reprise du commit sont vérifiées avant réponse. La recette réelle du moteur canonique, le déploiement des migrations et l’espace utilisateur restent à compléter ; ce point d’entrée n’est pas déployé.

L’API `GET /clients/:id/contracts/:contractId/replenishment` lit la dernière préparation. `POST .../replenishment/commands` accepte uniquement `PREPARE`, la version du contrat, l’identifiant du plan précédemment affiché (ou null), le hash de couverture et l’horizon. Les quantités et articles sont recalculés côté serveur. La préparation et son historique ne créent ni OF, ni achat, ni réservation, ni stock.

Critères ciblés :

1. Besoins 17 / 28 / 5, lot 20 : conserver deux propositions mensuelles, représentant 1 + 2 lots, cibles 30/09 et 31/10, 60 unités proposées et surplus final projeté 10.
2. Rejouer la même tentative : même événement et mêmes identités, aucune deuxième préparation.
3. Soumettre le même calcul avec une autre clé : plan conservé, nouvel événement de confirmation ; aucun deuxième lot.
4. Modifier stock, échéance, article applicable ou planning : ancien hash refusé, recalcul guidé.
5. Préparer un calcul révisé : ancien plan supersédé, snapshot et propositions conservés, motif technique attesté par le nouveau hash.
6. Deux créations simultanées : un seul plan courant ; l’autre reçoit un conflit exploitable.
7. Quantité avec plus de trois décimales ou hors plafond : refus explicite, jamais d’arrondi silencieux.
8. Qualité bloquée, brouillons, ancien stock : les exclusions du calcul canonique restent inchangées.
9. Audit absent ou transaction incertaine : aucun succès local inventé ; retrouver la tentative initiale.

Tests PostgreSQL isolés : `CLIENT_REPLENISHMENT_1032_TEST_DATABASE_URL` doit désigner exactement une base **vide** `cerp_replenishment_1032_test` sur PostgreSQL 17. Ce test refuse les bases ERP et initialise seulement ses dépendances minimales fictives. Exécuter `src/__tests__/client-replenishment-preparations-1032.postgres.integration.test.ts`, conserver le résultat et préciser s’il a été ignoré faute de base. L’installation réelle sera validée séparément avec la répétition des migrations et sauvegardes de Test/Prod.

Restent à réaliser : génération canonique des OF, rapprochement des OF déjà générés, affichage utilisateur/action planificateur et recette métier commune. Le parent #1032 reste ouvert.
