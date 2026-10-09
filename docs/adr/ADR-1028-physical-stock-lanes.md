# ADR #1028 — Pistes physiques, projection et activation progressive

Statut : socle implémenté ; activation du routage et recette globale en attente.
Source : réunion métier du 9 octobre 2026, décisions confirmées par Keenan ; [chantier #1252](https://github.com/BigFootLime/crp-systems-web/issues/1252), [tâche #1028](https://github.com/BigFootLime/erp-crp-backend/issues/1028).

## Décision

Les rôles FREE (stock libre), DELIVERY (attente livraison), ASSEMBLY (piste assemblage) sont portés par les localisations physiques canoniques. La table `stock_lane_locations` contient leur rôle et leur version, jamais de quantité. La projection `v_stock_lane_positions_1028` réutilise `v_stock_availability_225` et les réservations actives ; elle distingue physique, réservé et non réservé, par position et unité. OLD/NEW et lots restent issus du registre existant.

Les niveaux, batches et mouvements canoniques restent l'unique solde. Réserver n'est pas produire, déplacer n'est pas consommer, un reliquat non réservé n'est pas nécessairement libéré par la qualité. `availability_scope=PHYSICAL_LOT_STATUS_ONLY` interdit d'interpréter la projection comme l'autorisation de démarrer ou livrer.

La configuration requiert la capacité stock existante `referential_manage`. Elle contrôle l'activité, le mapping physique, le type STORAGE et les entrées/sorties. Un emplacement occupé ne change pas de rôle. Une première classification occupée en FREE est possible uniquement sans réservation de livraison ou montage ; les autres cas nécessitent une répartition explicite. Aucune pièce historique n'est reclassée implicitement.

Chaque confirmation reçoit un UUID, une version attendue, une empreinte et une raison. Les verrous portent sur la localisation, son mapping, les soldes et la clé de confirmation. Un rejeu identique restitue son résultat ; une version modifiée ou une réutilisation différente retourne 409. Configuration, preuve immuable et audit/outbox partagent la transaction.

## Activation et limites

Ce premier incrément expose `routing_active=false`. Il peut préparer les zones sans changer les réceptions de production actuelles. Le routage automatique (#1029), les transferts accompagnés de réservations, la disponibilité du nouveau flux et la reprise contrôlée doivent être raccordés avant activation. La tâche #1028 demeure ouverte tant que ces critères et sa recette ne sont pas validés.

La migration est additive. Les scripts preflight/verify contrôlent les prérequis, l'unicité des positions et leur égalité avec les soldes canoniques ; un écart de réservations est exposé et ne déclenche jamais une correction automatique. Le rollback refuse de supprimer des configurations ou preuves utilisées.

## Validation

Compilation TypeScript et contrat OpenAPI requis par incrément. Les tests métier, UI, autorisations et concurrence sont préparés pour la recette globale, conformément à la demande explicite de Keenan ; ils ne sont pas déclarés exécutés.
