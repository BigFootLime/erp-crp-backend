# ADR-0091 — Dossier OF complet avant planning

Statut : adopté pour le lot L1, mise en service non réalisée.
Date : 2026-10-06.
Suivi : backend #811 / web #1095. Complète ADR-0090.

## Contexte

Le métier demande quatre rubriques avant planning : plan client, matière première, traitement et sous-traitance. La programmation et les autres documents peuvent arriver ensuite. Le précédent dossier Complet dépendait des créneaux et sa validation était invalidée par un déplacement du planning.

## Décisions

- La version 2 des règles distingue exigences avant planning et avertissements secondaires. Les preuves restent calculées depuis la révision PT ; une valeur non applicable exige un motif. La MP non applicable est limitée au montage sans matière directe.
- Complet valide une définition technique et une quantité, indépendamment des créneaux. Le planning central et la garde SQL exigent cette validation pour les OF de version 2. Les fabrications de version 1 conservent leurs empreintes et leurs preuves.
- Les preuves tardives de programmation et de contrôle sont propres à l’OF dans technical_preparation.execution_programming/execution_quality. Elles ne remplacent pas technical_snapshot. Une définition de programme déjà complète ne peut pas être changée silencieusement.
- Une programmation peut être ajoutée avant tout usinage engagé, sous contrôle des versions attendues, des habilitations et de l’audit. Une fiche d’autocontrôle vient d’un plan publié de la même révision et correspond à la quantité lancée.
- Les six gardes SQL d’exécution restent actives. L’API explique explicitement une fiche manquante. Un montage sans composants définis reste bloqué au lancement.

## Conséquences et validation

L’interface affiche les manques secondaires en jaune et les choix définis restent protégés. Une gamme/structure manquante n’est pas inventée : la modification d’une définition figée suit le parcours de révision puis revalidation. Les gardes physiques matière et qualité ne sont pas assimilées à la seule complétude documentaire.

77 tests ciblés et 15 scénarios PostgreSQL isolés réussis ; typechecks frontend/backend réussis. Les 235 patches du schéma jetable et la vérification SQL des six gardes passent. La release complète, la recette atelier cerp_test et la mise en service restent à réaliser.

Recette : [document frontend](https://github.com/BigFootLime/crp-systems-web/blob/feature/1095-of-complet-avant-planning/docs/functional/of-completion-before-planning-1095.md).
