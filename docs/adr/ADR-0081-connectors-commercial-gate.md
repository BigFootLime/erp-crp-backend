# ADR-0081 — Gate commercial des connecteurs comptables et EDI

- Statut : accepté
- Date : 2026-08-15
- Décideur produit : Keenan Martin
- Périmètre : premier adaptateur comptable ou EDI spécifique à un tiers

## Contexte

SOL-36 exige qu'un premier connecteur soit choisi à partir du besoin d'un client
payant. Aucun client, logiciel, protocole, contrat d'import, bac à sable ou jeu de
secrets n'est actuellement déclaré. La base `cerp_prod` contient zéro connexion de
Plateforme Agréée, zéro version de mapping comptable et zéro lot d'export. Les
issues GitHub ne portent aucune demande client pour Sage, Cegid, EBP, Pennylane,
EDIFACT ou un autre tiers.

Le socle livré par SOL-26 et SOL-27 fournit déjà les frontières sûres utiles :
adaptateurs indépendants du fournisseur, données canoniques, mappings versionnés,
validation, empreintes, idempotence, reprise, rapprochement, audit, RBAC et
références de secrets. `GENERIC_DELIMITED_V1` reste un export générique contrôlé ;
il ne constitue pas un connecteur fournisseur réel.

## Décision

Le développement d'un adaptateur réel est **refusé tant que le gate commercial
n'est pas satisfait**. Il est également interdit d'ajouter maintenant une nouvelle
couche générique de transport, une dead-letter queue ou une sandbox factice : ces
choix dépendent du contrat et du comportement du tiers réellement sélectionné.

Une demande devient éligible seulement si son dossier contient simultanément :

1. le client payant et le propriétaire métier identifiés ;
2. le flux prioritaire, sa fréquence, ses volumes et son impact mesurable ;
3. le produit, fournisseur, version et protocole exacts ;
4. une spécification contractuelle versionnée et des exemples acceptés ;
5. un environnement de test réel, ses limites et ses scénarios de rejet ;
6. le modèle d'authentification, la rotation et l'isolation des secrets ;
7. les SLA, limites de débit, règles de retry, idempotence, rejeu et réconciliation ;
8. les responsabilités de support, le prix et la date de dépréciation éventuelle.

À satisfaction du gate, l'équipe implémentera le chemin vertical minimal dans les
frontières SOL-26/SOL-27 : transport, transformation, orchestration et audit seront
séparés seulement aux points imposés par le tiers. Les tests contractuels utiliseront
le véritable bac à sable. L'effort du deuxième adaptateur sera mesuré après le
premier, à partir du diff réel, et non estimé par une abstraction spéculative.

## Compatibilité et rollback

Cette décision ne modifie ni le runtime, ni le schéma, ni les données. Elle conserve
l'export générique et l'état explicite `NO_QUALIFIED_PROVIDER`. Le rollback consiste
à révoquer cet ADR si un dossier client complet satisfait les huit critères ; aucune
restauration de base n'est nécessaire.

## Conséquences

CERP+ ne prétend pas être connecté à un système externe et n'engage aucun coût de
support sans financement. Le prochain travail est une qualification commerciale,
pas une implémentation technique.
