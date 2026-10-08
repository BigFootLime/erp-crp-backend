# ADR 1001 — Journal des allocations de coût fabriqué

Les réceptions physiques #995 et les bases de coût déclarées #998 n'étaient pas encore raccordées au projecteur. Une base connue doit être partagée entre ses réceptions sans reproduire le coût total ni recalculer des montants historiques depuis un prix courant.

## Décision

Le projecteur utilise une base immuable de l'OF, seulement pour une réception entreprise à propriétaire unique, en unités de pièces et EUR. L'OF, la PT/version, l'article lorsque défini et la quantité doivent correspondre aux faits figés au commit de réception. Une base financière ultérieure peut être utilisée avant la projection, mais elle ne réécrit aucune entrée déjà projetée.

Chaque réception alloue sa part du montant et de la quantité restants. La dernière reprend le reliquat exact, avec douze décimales internes. Le coût reste DECLARED, comme sa base. Les sources incomplètes, ambiguës, incompatibles ou absentes produisent un montant inconnu ; elles ne deviennent pas un prix nul ou une valeur de vente. Le stock client ne consomme pas le budget de valeur entreprise.

Un événement immuable porte la base, la réception, l'entrée CUMP, le périmètre, les deltas signés, les états avant/après et leurs SHA. Un curseur net est contrôlé par son dernier événement. Les gardes vérifient les plafonds de quantité/valeur et l'allocation exacte du reliquat. Une contrainte différée exige l'entrée CUMP correspondante au commit. Le projecteur conserve son verrou de contrôle, sa barrière de journal et son curseur global ; aucun verrou de stock physique n'est ajouté.

## Annulations

Le calcul existant des retours fournit le montant exact d'origine. Lorsqu'un retour vise une entrée portant une allocation de fabrication, le budget reçoit l'effet inverse. La preuve Stock doit porter le lien explicite d'annulation et l'entrée antérieure. Une annulation d'annulation réapplique son montant original, au lieu de recalculer une part au coût restant courant.

Les plafonds sont calculés sur les effets **nets** de l'arbre des inverses. L'annulation d'une annulation restitue donc la capacité de ses ancêtres. Les profondeurs non prises en charge sont refusées et la valeur reste inconnue. Le journal de retour, le budget de fabrication et la valeur CUMP sont écrits dans une même transaction ; en cas de preuve invalide, un savepoint annule ensemble les modifications des deux allocations. Les erreurs SQL/connexion interrompent le consommateur financier et ne sont pas converties en réussite métier.

## Limites et suite

Pas de valorisation des réceptions antérieures dépourvues de capture, pas de conversion de devise/unité, pas de coût catalogue et pas d'activation CUMP. Les montants d'ouverture, les corrections de facture/coûts tardifs et la présentation Stock/Marges restent à terminer. La réception physique et l'atelier ne dépendent pas de l'existence de cette preuve financière. Le contrôle de quantité de production est un sujet distinct.

Le projecteur demeure PREPARED après cette livraison. L'allocation ne s'exécutera qu'après activation explicite et recette finale. WP278/#977 restent en cours.

## Validation et déploiement

Migration additive avec préflight, vérification et rollback manuel refusant un journal/curseur non vide. TypeScript/build/OpenAPI et DDL + sept requêtes PREPARE/EXPLAIN sous ROLLBACK sur Test/Production. La première erreur de syntaxe PL/pgSQL a été corrigée avant fusion et déploiement, sans mutation durable des bases.

Fixtures d'adaptateur et recettes PostgreSQL/sécurité/concurrence préparées **NON EXÉCUTÉES**, conformément à la demande de recette commune finale. Sauvegardes complètes et dumps séparés avant Test, Production HYPERBOX2 et API publique ; santé, version, routage et migrations vérifiés ensuite.
