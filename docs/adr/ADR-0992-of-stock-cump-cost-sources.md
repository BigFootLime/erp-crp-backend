# ADR 0992 — Coûts Stock des OF et retours nets

Statut : implémenté, recette finale différée. Issue backend #992 / WP278 / #977.

Les sources matière, consommables et composants des marges ACTUAL/UPDATED lisaient
le prix déclaré sur chaque ligne physique. Il prouve le prix appliqué à cette
ligne, sans prouver un CUMP ni enlever les retours matière valorisés.

## Décision

Une instruction PostgreSQL rassemble les trois sources et leurs preuves de
journal, entrées CUMP et curseurs nets de retour. Les identités de coûts restent
`stock-consumption:<ligne>` afin de conserver les protections contre les doublons
et collisions avec les données manuelles. La règle d'accès aux marges/prix reste
celle du module existant ; aucune nouvelle route ou permission.

Une racine avec une seule ligne physique, un seul propriétaire/unité/devise et
une affectation OF prouvée peut prendre sa valeur de sortie historique exacte.
Le calcul CUMP est revérifié depuis l'état avant mouvement, avec comparaison de
l'état après et du montant de sortie. Le dernier curseur immuable prouvé retire
les quantités et valeurs **nettes** rendues au stock, y compris les annulations
déjà prises en compte dans ce curseur. Aucun coût unitaire courant n'est utilisé
pour revaloriser l'ancienne sortie. La valeur conserve sa fiabilité DECLARED ou
VERIFIED ; une quantité physique seule ne vérifie pas son prix.

Les lots appartenant au client, avec preuve physique d'affectation univoque, sont
explicitement NOT_APPLICABLE au coût société. Leur propriétaire provient du
journal figé, jamais de la fiche lot actuelle. La casse du code client est intacte.

En PREPARED, les prix appliqués historiques continuent comme DECLARED et
« CUMP non vérifié ». En ACTIVE, formule/init/retard/preuve/arithmétique divergents
rendent le coût UNKNOWN ; aucun retour à un prix courant ou catalogue. Les coûts
ambigus restent inconnus. Lecture bornée à 10 000 sources : dépassement explicite,
sans total partiel. Aucun stock, projecteur, facture ou déclaration n'est modifié.

## Limites

Les racines multi-lignes ne sont pas réparties arbitrairement, notamment lorsque
le retour doit être rattaché à une ligne précise. Ce cas devra posséder une preuve
d'allocation avant activation générale. Cette étape n'active pas le projecteur,
ne justifie pas l'ouverture historique et ne valorise pas les entrées de pièces
fabriquées. Ces adaptations restent dans WP278/#977. Le moteur Marge conserve son
arrondi interne à six décimales et son affichage monétaire ; le journal conserve
douze décimales et la valeur d'origine est transmise en texte exact.

## Validation / retour arrière

TypeScript/build, contrat OpenAPI et PREPARE/EXPLAIN READ ONLY ROLLBACK sous
cerp_app Test/Production. Scénarios métier et sécurité préparés **NON EXÉCUTÉS**,
recette finale commune différée à la demande utilisateur. Voir
`cump-stock-cost.test.ts` et `RECETTE-0992-of-stock-cump-costs.md`.

Aucune migration. Retour arrière par l'artefact backend précédent vérifié,
sans annulation de donnée physique ou financière.
