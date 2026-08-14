# ADR-0070 — Frontière de pilotage affaires, temps et déplacements

- Statut : accepté
- Date : 2026-08-14
- Décideur : Keenan Martin
- Périmètre : Project Office, affaires, temps RH, absences, kilomètres et clôtures

## Contexte

Le Project Office savait suivre projets, lots, jalons, dépendances et risques,
mais ne disposait ni d'un budget versionné ni d'un lien explicite vers les
affaires qui portent les coûts constatés. Le module Temps & Déplacements savait
pointer, corriger et déclarer des kilomètres, mais l'absence explicite, la
clôture de période, le taux kilométrique daté et la file d'exceptions n'avaient
pas de frontière serveur cohérente.

Calculer un budget restant avec un coût incomplet, assimiler une absence non
qualifiée à zéro heure, valoriser des kilomètres avec le taux courant ou laisser
une personne approuver sa propre saisie produirait une décision non traçable.

## Décision

### Project Office

- Le budget est une suite de versions datées et non un champ mutable. Chaque
  version porte montant, devise, définition, type/référence de source, date
  d'observation, fiabilité, auteur et version remplacée.
- Le consommé HT est la somme exacte des coûts `ACTUAL` complets du moteur de
  marge pour les affaires explicitement liées au projet. Si une affaire est
  partielle, `consumed_ht` et `remaining_ht` restent `null`; le sous-total
  partiel est exposé séparément et marqué `PARTIAL`.
- Le restant n'est calculé que lorsque budget et consommé complet sont
  comparables en EUR. Une devise différente est `UNAVAILABLE`, jamais convertie
  implicitement.
- Les heures prévues/réalisées sont les sommes des lots non annulés. Les lignes
  incomplètes dégradent la fiabilité en `PARTIAL`.
- Le burn-up sur douze semaines est `ESTIMATED`: l'échéance donne le prévu et
  `updated_at` la meilleure preuve disponible de terminaison. Aucun historique
  antérieur n'est inventé.
- Les liens affaire, budgets, risques, jalons et dépendances restent des
  drill-downs vers leurs entités sources. Les mutations exigent un rôle projet
  de gestion et écrivent activité projet et audit global dans la transaction.

### Temps, absences et déplacements

- Une absence est un enregistrement explicite demandé, approuvé, rejeté ou
  annulé. Un déficit contractuel sans absence approuvée reste « manque non
  justifié »; il n'est pas requalifié automatiquement.
- Les corrections, absences, journées/semaines et kilomètres ne peuvent pas être
  auto-approuvés. Le salarié agit sur son identité issue du jeton; un manager est
  limité à ses collaborateurs; RH/Direction/Administration disposent du
  périmètre global.
- La clôture d'une période est refusée tant que journées, semaines, anomalies,
  corrections, kilomètres ou absences restent en attente. Elle bloque ensuite
  toute mutation couvrant la période et peut uniquement être rouverte avec audit.
- Un taux kilométrique est versionné par type de véhicule et date d'effet. La
  validation photographie la version, le coût et la devise applicables à la date
  du trajet. L'absence de taux bloque la valorisation au lieu de produire zéro.
- La file opérationnelle serveur regroupe feuilles non validées, anomalies,
  corrections et absences en attente, doublons kilométriques et kilomètres
  validés non valorisés.

## Données décisionnelles

| Donnée | Unité / période | Source | Fraîcheur | Fiabilité |
|---|---|---|---|---|
| Budget courant | devise, période d'effet | `project_budget_versions` | `observed_at` | valeur déclarée ou vérifiée par la version |
| Consommé / restant | EUR HT, état courant | moteur de marge `AFFAIRE/ACTUAL` | plus ancienne source liée | `ACTUAL`, `PARTIAL` ou `UNAVAILABLE` |
| Temps prévu / réalisé | heures, vie du projet | `project_work_packages` non annulés | dernier `updated_at` | `VERIFIED` ou `PARTIAL` |
| Burn-up | lots, douze semaines | lots et échéances | génération de la réponse | `ESTIMATED` |
| Coût kilométrique | devise, date du trajet | entrée km + version de taux applicable | validation | `DECLARED`/`VERIFIED` selon le taux |

## Sécurité et confidentialité

Les routes restent sous authentification et gardes module. Les lectures projet
appliquent l'anti-IDOR existant. Les opérations RH n'exposent ni trajet détaillé
à un manager hors périmètre ni donnée d'un autre salarié. Les audits stockent
identifiants métier, décisions et métadonnées, pas de contenu documentaire ni de
secret. Le schéma actuel n'a pas de dimension société/site exploitable pour ces
domaines; aucune isolation fictive n'est revendiquée.

## Migration et retour arrière

Le patch `20260814_project_operations_sol24.sql` est additif et rejouable. Il
ajoute budgets, liens affaire, absences, clôtures, taux et snapshots de coût
kilométrique, avec contraintes et index. Le rollback SQL est réservé à
`cerp_test`, exige zéro donnée SOL-24 et sert à la répétition. En production, le
retour applicatif consiste à redéployer le SHA précédent en conservant les objets
additifs. Si un retour de schéma est indispensable après écriture, geler les flux
et restaurer le dump pré-migration dans une base neuve.

## Conséquences

Les chiffres incomplets deviennent visibles mais parfois indisponibles, ce qui
est volontaire. Les coûts constatés restent sous l'autorité du moteur de marge;
SOL-24 ne crée pas de second grand livre. Les clôtures et taux demandent une
configuration RH réelle avant validation. Une future historisation explicite de
la date de terminaison pourra faire passer le burn-up de `ESTIMATED` à `ACTUAL`.
