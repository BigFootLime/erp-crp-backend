# Grille d'acceptation d'une fonctionnalité CERP+

À remplir avant estimation puis à relire avant promotion en production. Les sources
doivent être liées ; « inconnu » n'est jamais remplacé par une hypothèse favorable.

## Identité de la décision

| Champ | Valeur attendue |
|---|---|
| Identifiant / titre | issue ou work package unique |
| Demandeur et décideur | personnes responsables |
| Clients concernés | noms internes ou segment, sans PII |
| Problème observé | preuve du flux ou incident, pas une solution proposée |
| Résultat attendu | indicateur, unité, période et seuil |
| Échéance / contrat | date et engagement source |
| Propriétaire après livraison | produit et exploitation |

## Gates obligatoires

Une réponse `NON` bloque l'acceptation. `N/A` exige une justification vérifiable.

| Gate | Question | Preuve minimale |
|---|---|---|
| besoin client | le problème réel et son propriétaire sont-ils confirmés ? | entretien, contrat, incident ou données |
| fréquence | connaît-on la fréquence et le nombre d'utilisateurs ? | période mesurée et source |
| réutilisabilité | le cœur sert-il plusieurs clients sans fork ? | frontière commune / configuration |
| coût complet | build, migration, support et retrait sont-ils chiffrés ? | estimation avec hypothèses |
| sécurité | auth, RBAC, isolation, audit et secrets sont-ils couverts ? | revue et tests négatifs |
| exploitation | health, logs, alertes, backup et runbook sont-ils prévus ? | plan opérable et propriétaire |
| données | source, unité, période, fraîcheur et fiabilité sont-elles définies ? | contrat de données |
| tests | unitaires, intégration, migration et E2E sont-ils proportionnés ? | scénarios et fixtures isolées |
| prix | le coût récurrent est-il couvert par le produit ou le client ? | règle tarifaire / contrat |
| sortie | rollback, feature flag éventuel et retrait sont-ils définis ? | plan daté |

## Classement

Après les gates, qualifier chaque axe `FAIBLE`, `MOYEN` ou `FORT` avec une phrase de
preuve. Il n'existe pas de total automatique : un chiffre unique masquerait les
risques asymétriques.

| Axe | Questions d'arbitrage |
|---|---|
| valeur | fréquence, temps gagné, risque évité, engagement commercial |
| portée | nombre de clients, rôles, sites, transactions et documents |
| complexité | états, intégrations, concurrence, migrations et reprise |
| charge récurrente | support, supervision, données de référence, formation |
| réversibilité | capacité de désactivation, export et retour arrière |

## Décision

Cocher une seule issue :

- [ ] **Noyau produit** — besoin réutilisable, coût mutualisé et maintenance produit.
- [ ] **Extension client financée** — contrat stable, configuration isolée, support
  et retrait financés ; aucun fork.
- [ ] **Expérience bornée** — flag faux par défaut, population, métrique, propriétaire
  et date de fin explicites.
- [ ] **Différée** — preuve ou capacité manquante, prochaine action et date.
- [ ] **Refusée** — conflit produit, risque ou coût disproportionné documenté.

La décision mentionne décideur, date, durée de validité et conditions de réexamen.
Une PR fonctionnelle significative lie cette grille ou justifie pourquoi le
changement est purement correctif.

## Revue après livraison

À 30 et 90 jours, relever usage réel, incidents, temps de support, coût
d'infrastructure, résultat métier et écarts aux hypothèses. La promotion d'une
extension vers le noyau exige au moins deux usages clients indépendants et le
respect des gates ; elle n'est jamais automatique.
