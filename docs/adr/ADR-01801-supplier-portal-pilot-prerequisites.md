# ADR-01801 — Préparation locale du portail fournisseur

- Statut : proposé
- Date : 2026-10-31

## Décision proposée

Le pilote demande d'exploiter les promesses d'achat et de sous-traitance dans
le planning interne. CERP expose donc une vue interne, authentifiée et
strictement en lecture, des accusés manquants, dates manquantes, retards et
leurs liens vers les OF et commandes clients.

La décision ne révoque pas ADR-0080. Une exception strictement locale est
autorisée pour la recette : un compte de fixture haché et une route qui renvoie
`404` hors de `NODE_ENV=test`, d'une base `cerp_test` en boucle locale et d'un
opt-in explicite. Elle ne crée aucune invitation, aucun contact réel, aucun
document, aucun envoi ni notification tierce ; elle ne modifie jamais une
commande ou une promesse sans revue Achats.

## Prérequis avant un portail fournisseur

La phase externe reste bloquée jusqu'à ce que les cinq preuves ADR-0080 soient
jointes à une ADR de remplacement :

1. deux commandes réelles, non annulées, du même fournisseur sur douze mois ;
2. un besoin répété formalisé par écrit ;
3. un fournisseur pilote consentant, avec propriétaire Achats et support nommés ;
4. une politique approuvée de données, validation et conservation ;
5. un pilote isolé avec invitations, récupération de compte et secrets dédiés.

Les données de fixtures et le bac à sable local ne constituent pas ces preuves.
