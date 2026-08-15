# ADR-0083 — Gate maintenance, données machine et OEE

- Statut : accepté
- Date : 2026-08-15
- Décideur produit : Keenan Martin
- Périmètre : GMAO ciblée, télémétrie et TRS/OEE

## Contexte

Le parc CERP+ possède déjà la GMAO minimale adaptée à l'atelier : machines,
spécifications, plans datés ou à compteur, échéances, checklists, responsables,
indisponibilités reliées au Planning et événements append-only. Les routes appliquent
RBAC, contrôle horizontal, concurrence et audit. Ajouter un second module de
maintenance dupliquerait cette source de vérité.

La donnée réelle n'est toutefois pas encore alimentée. `cerp_prod` contient douze
machines actives, mais zéro plan de maintenance, événement, indisponibilité et
pointage de production. Aucune table de télémétrie, observation machine, compteur
machine ou OEE n'existe. ADR-0031 confirme qu'aucune machine n'est connectée.

## Décision

### Maintenance

La GMAO ciblée existante est conservée et constitue la seule frontière de
maintenance CERP+. Son activation opérationnelle exige un inventaire terrain validé,
pas une nouvelle implémentation : plan, périodicité ou compteur, unité, prochaine
échéance, checklist, responsable, pièces/document et règle d'indisponibilité pour
chaque équipement concerné.

Une maintenance bloquante reste un événement Planning explicite. Aucun conflit ne
peut être masqué et aucune échéance n'est fabriquée à partir du modèle commercial de
la machine.

### OEE/TRS

Le TRS reste `computable=false`, `value=null`. Il ne devient calculable que si une
période prouve simultanément :

1. le temps d'ouverture planifié versionné ;
2. les arrêts planifiés et non planifiés, avec cause et horodatages fiables ;
3. le temps de marche mesuré ;
4. une cadence nominale versionnée pour l'opération et la machine ;
5. le nombre total produit et le nombre bon après décision Qualité ;
6. une liaison non ambiguë machine → opération → OF ;
7. une couverture, une fraîcheur et une horloge synchronisée suffisantes.

Disponibilité, performance et qualité sont publiées séparément avec source,
fraîcheur, couverture et éléments manquants. Une composante absente rend l'OEE non
calculable ; elle n'est jamais remplacée par zéro ou une estimation.

### Connectivité machine

Aucun adaptateur n'est implémenté sans machine et client financés. Le premier pilote
portera sur un seul type de machine réel. Il suivra ADR-0031 : passerelle locale en
pull, réseau OT non exposé, allowlist, observations horodatées et dédoublonnées,
aucune commande de machine, aucune fermeture automatique d'OF et réconciliation
humaine des compteurs.

Avant activation, le rapport qualité doit mesurer au minimum couverture temporelle,
trous, doublons, événements hors ordre, dérive d'horloge, valeurs impossibles,
déconnexions et part d'observations rapprochées à un OF. Le seuil d'acceptation est
contractuel et documenté pour la machine pilote.

## Compatibilité et rollback

Cette décision ne change ni runtime ni schéma. Les écrans existants continuent
d'afficher les manques et l'OEE indisponible. Le rollback documentaire consiste à
révoquer l'ADR après preuve d'un pilote financé ; toute future passerelle devra être
désactivable indépendamment et la production manuelle restera le fallback sûr.

## Conséquences

CERP+ conserve une maintenance utile sans devenir une plateforme IoT universelle.
Les douze machines ne sont pas déclarées « connectées » et aucun taux OEE n'est
affiché avant données mesurées fiables.
