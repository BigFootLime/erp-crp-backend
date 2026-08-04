# Machine d'état canonique des commandes client (#314)

Le backend est l'autorité unique du contrat de workflow. Le statut persistant
reste exclusivement l'historique append-only `commande_historique`; aucune
colonne de projection `commande_client.statut` n'est créée ni utilisée.

## Déploiement

Aucune migration n'est requise par cette livraison. Les tables, contraintes et
index nécessaires existent déjà via les patchs historiques du workflow et des
checkpoints. Avant le déploiement applicatif, exécuter manuellement, sur la base
explicitement ciblée, le script read-only
`db/patches/support/20260804_commande_workflow_canonical_314.preflight.sql`.
Après déploiement, exécuter de la même manière le script read-only
`db/patches/support/20260804_commande_workflow_canonical_314.verify.sql`.
Ces scripts ne sont pas chargés par `db:patches:up` et cette livraison ne les
exécute pas automatiquement.

Les dernières lignes utilisant les aliases historiques `ENREGISTREE`,
`PLANIFIEE`, `AR_ENVOYEE` ou `LIVREE` restent lisibles et sont normalisées en
mémoire. Une commande sans historique est lue comme `BROUILLON`; sa première
écriture doit néanmoins suivre exactement l'arête canonique `BROUILLON` vers
`EN_ANALYSE`. Un dernier statut inconnu est refusé avec un conflit explicite et
doit être réparé manuellement après audit.

## Retour arrière

Le rollback est exclusivement applicatif puisqu'aucun DDL ni backfill n'est
livré. Drainer les écritures de commande, redéployer ensemble les versions
précédentes du backend et du frontend, puis rouvrir le trafic. Ne supprimer et
ne réécrire aucune ligne de `commande_historique`, de checkpoint ou d'événement :
les écritures canoniques produites par cette version restent valides et
auditables par l'ancienne application. Si le rollback fait suite à une erreur,
conserver les journaux et vérifier les commandes touchées avant reprise.

Le preflight compare les 14 checkpoints de chaque commande à la projection
attendue depuis l'historique normalisé et le `order_type`. Il échoue avant le
rapport (`RAISE EXCEPTION`, avec `ON_ERROR_STOP`) en cas de checkpoint
manquant/supplémentaire, statut ou ordre incohérent, futur checkpoint déjà
terminé, blocage invalide, ou skip incorrect sur les parcours interne et
entièrement couvert par le stock. Le SELECT final, limité à 100 commandes,
reste uniquement un diagnostic opérateur lorsque le gate est vert.

La réparation/backfill doit rester manuelle et contrôlée avant déploiement,
conserver l'historique append-only, être revue commande par commande et disposer
de sa propre sauvegarde/transaction et procédure de retour arrière ; aucun
backfill automatique n'est fourni par cette livraison. Les commandes sans aucun
checkpoint font également échouer le gate. Aucune anomalie n'est seulement
listée : toute incohérence détectée interrompt le script et signifie
explicitement `BLOCKED`.
