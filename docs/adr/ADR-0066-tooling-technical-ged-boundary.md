# ADR-0066 — Frontière outillage, dossier technique et GED

- Statut : accepté
- Date : 2026-08-13
- Décideur technique : CERP+
- Contrat : `CERP-TOOLING-TECHNICAL-GED-1.0.0`
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/438

## Contexte

Le stock d'outils historique ne conservait qu'un mouvement d'entrée ou de sortie.
Il ne reliait pas de façon obligatoire l'outil à la pièce, à l'indice technique et
à l'OF, et ne distinguait ni réservation, retour, casse, usure, retry ni clôture.
Le dossier technique possédait déjà des indices immuables, des gammes, contrôles
et exigences documentaires. La GED centrale possédait déjà versionnement,
validation, rétention, antivirus et quarantaine. Créer des cycles concurrents
aurait produit deux vérités incompatibles.

## Décision

Le backend reste la source autoritaire. Il complète les frontières existantes :

- une exigence d'outil appartient à un indice technique et devient immuable dès
  que l'indice est `APPLICABLE` ou `OBSOLETE` ;
- une réservation capture l'identité de la pièce, son indice courant applicable,
  l'OF éventuel et les paramètres de coût/durée de vie valides à cette date ;
- le cycle autorisé est `RESERVE → ISSUE → RETURN|BREAK|WEAR`, avec libération
  explicite du reliquat. Chaque transition est transactionnelle, auditée et
  idempotente par acteur et clé ;
- une sortie physique décrémente le stock sous verrou ; un retour l'incrémente.
  Casse et usure consomment la quantité sortie sans fabriquer un retour ;
- une nouvelle sortie est refusée dès que l'indice n'est plus courant et
  applicable. Le retour et le traitement d'une sortie antérieure restent permis ;
- disponibilité = stock physique connu − réservations ouvertes non sorties. Un
  stock absent reste `null` ;
- durée observée = pièces bonnes des OF liés ÷ outils cassés ou usés ;
- coût par pièce = snapshots de coût des outils cassés ou usés ÷ pièces bonnes.
  Il reste indisponible si un coût manque ou si plusieurs devises apparaissent ;
- la matrice serveur vérifie indice, plan GED propre/applicable, gamme applicable,
  contrôle publié, matière, outillage disponible et documents obligatoires gelés ;
- les fichiers ne sont jamais copiés dans un stockage SOL-20. Les liens pointent
  vers la GED centrale et ne sont exploitables qu'avec un verdict antivirus
  `clean` et une quarantaine `released`.

Chaque donnée décisionnelle expose définition, unité, période, source, fraîcheur,
fiabilité et manquants. Les rôles ne suffisent pas seuls : le module doit aussi
être accordé. Les mutations de référentiel sont réservées à l'administration ou
aux responsables autorisés.

## Conséquences

Un dossier peut expliquer précisément ce qui manque et l'URL de correction. Une
consommation d'outil remonte à l'utilisateur, la pièce, l'indice, l'OF, les
mouvements et les paramètres datés. Les anciens mouvements restent consultables,
mais ne sont pas rétroactivement qualifiés comme preuves SOL-20.

## Migration et retour arrière

La migration est additive, avec `lock_timeout=5s` et `statement_timeout=60s`.
Elle ajoute quatre tables, trois colonnes d'identité outil et six colonnes d'audit
sur les mouvements historiques. Elle n'insère aucune donnée métier.

Avant la première preuve, le rollback supprime les nouveaux objets ; il refuse dès
qu'une ligne métier existe. Les colonnes historiques additives sont conservées car
elles restent compatibles. Après démarrage réel, le retour applicatif consiste à
redéployer la version précédente, qui ignore les objets ; un retrait de schéma
exige gel des écritures et restauration du dump pré-migration dans une nouvelle
base.
