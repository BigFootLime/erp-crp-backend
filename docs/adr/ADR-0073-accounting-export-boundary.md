# ADR-0073 — Frontière d'export comptable configurable

- Statut : accepté
- Date : 2026-08-14
- Décideur métier : Keenan Martin
- Périmètre : factures, avoirs et paiements sortants vers un logiciel comptable

## Contexte

CERP+ possède les pièces commerciales et leurs règlements, mais aucun logiciel
comptable prioritaire, contrat d'import ni plan comptable définitif n'est déclaré.
Un export spécifique Sage, Cegid ou EBP serait donc une hypothèse non validée. Le
produit doit pourtant préparer des écritures contrôlables, empêcher les doublons et
laisser une preuve de ce qui a été remis au cabinet ou à la comptabilité.

## Décision

### Noyau canonique et adaptateur

- Le domaine construit des lignes canoniques en centimes exacts, indépendamment du
  format cible. L'interface `AccountingExportAdapter` transforme ensuite ces lignes.
- Le premier adaptateur est `GENERIC_DELIMITED_V1` : CSV UTF-8 avec BOM, délimiteur
  configurable et colonnes stables. Il ne prétend pas être un format propriétaire.
- Un adaptateur fournisseur dédié ne pourra être ajouté qu'après choix du logiciel,
  obtention de sa spécification d'import et qualification sur un environnement test.
- CERP+ ne devient pas un grand livre : saisie comptable finale, lettrage, clôture,
  déclarations, paie et corrections après import restent dans le logiciel comptable.

### Mappings versionnés

- Chaque version date son applicabilité et contient journaux de ventes/avoirs/banque,
  comptes clients, ventes, TVA, banque et axes analytiques.
- Le lot conserve l'identifiant et l'empreinte SHA-256 de la version utilisée. Une
  modification ultérieure crée une nouvelle version ; elle ne réécrit pas un lot.
- L'activation exige des comptes, journaux et taux explicitement mappés. Une donnée
  absente produit un bloqueur visible, jamais un compte ou un montant inventé.

### Cycle de vie et intégrité

- Le cycle est `PREVIEWED → VALIDATED → GENERATED`, puis éventuellement
  `CANCELLED`. Une annulation est logique, motivée et ne supprime aucune preuve.
- La validation relit les pièces sources et compare leurs empreintes. La génération
  refait le contrôle, réserve chaque source de manière unique, produit l'artefact et
  conserve taille et SHA-256. Une source modifiée rend le lot obsolète.
- Toute devise est équilibrée séparément. Chaque ligne porte exactement un débit ou
  un crédit positif. Les périodes, numéros, devises ISO, ventilations TVA, comptes
  tiers, comptes généraux et doublons sont contrôlés avant génération.
- La réexportation crée un nouveau lot relié au précédent ; elle n'écrase jamais le
  fichier historique. Elle n'est permise qu'après annulation et libération contrôlée
  des réservations.

### Idempotence, droits et audit

- Toute mutation exige une `Idempotency-Key`, liée à l'acteur et à l'empreinte de la
  commande. Une reprise identique restitue le même résultat ; un autre contenu avec
  la même clé est refusé.
- Lecture, exécution et administration des mappings sont trois capacités Finance
  distinctes. L'API applique ces droits côté serveur.
- Les créations, validations, générations, annulations et réexports sont audités
  avec acteur, request/correlation ID et identifiant de lot, sans contenu de fichier.

## Conséquences

Le socle est utilisable immédiatement pour un échange délimité contrôlé et donne un
rapport de rapprochement ERP ↔ export. L'import réellement accepté par le logiciel
comptable reste à qualifier. Aucun lot ne peut être généré tant que le mapping réel
n'est pas saisi et que toutes les pièces ne sont pas valides et équilibrées.

## Compatibilité et retour arrière

Le schéma est additif et l'ancien binaire l'ignore. Le rollback applicatif consiste
à redéployer le SHA précédent tout en conservant les lots. La suppression SQL est
réservée à une base test vide ; dès qu'une preuve existe, le script refuse et impose
une restauration du dump pré-migration dans une nouvelle base.
