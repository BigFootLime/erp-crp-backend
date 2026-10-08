# ADR 0998 — Base de coût fabriqué déclarée

Une réception physique d'OF prouve une origine, pas un coût de stock. Le lot #995 fige les faits de réception sans utiliser de prix de vente. Il faut une base monétaire explicitement validée avant de répartir un coût entre réceptions.

## Décision

La base choisie est un recalcul **ACTUAL sauvegardé** de cet OF. L'API propose son total de coût et la quantité bonne de l'opération finale ; le corps de validation contient uniquement l'identifiant du recalcul, une clé de demande et le SHA de l'aperçu. Aucun montant ni quantité libres ne sont acceptés.

Les opérations actives doivent être closes. La quantité bonne doit être positive, datée, reliée à l'opération finale et identique dans les mesures sauvegardées et courantes. Contrôle en attente, reprise non résolue, données tronquées, coût incomplet, formule/devise non prise en charge ou modification de l'OF/des opérations après le recalcul rendent la proposition indisponible. Les coûts sont recalculés uniquement depuis les **entrées immuables sauvegardées** pour contrôler le total ; aucun catalogue courant n'est consulté. L'absence de prix de vente n'empêche pas une base de coût connue.

Une validation crée une preuve immuable, un acteur, une date et un audit dans la même transaction. Elle reste **DECLARED**, y compris lorsque la marge utilisait des taux estimés. Elle ne devient jamais VERIFIED par la seule validation. Une base unique par OF est conservée ; les corrections futures demanderont des événements financiers distincts, pas sa réécriture.

Le contrôle du projecteur est verrouillé avant l'OF. La demande est idempotente et liée à l'acteur ; un SHA changé demande une actualisation. Les opérations sont verrouillées pendant la validation et les mises à jour concurrentes donnent une erreur métier 409 bornée. Une réception déjà projetée interdit cette voie de déclaration rétroactive : une correction financière séparée est nécessaire.

## API et droits

- `GET /margins/of/:ofId/manufacturing-basis/candidates/:snapshotId` : aperçu, capacité existante `read_costs`.
- `GET /margins/of/:ofId/manufacturing-basis` : base enregistrée ou absence explicite, même capacité.
- `POST /margins/of/:ofId/manufacturing-basis` : validation, capacité financière existante `snapshot` ; le simple accès de navigation/lecture au reporting ne donne pas ce droit.

Les réponses ne sont pas mises en cache. Les UUID sont normalisés ; les identifiants OF hors domaine bigint sont rejetés avant SQL. Aucun droit supplémentaire n'est accordé et aucun utilisateur réel n'est modifié.

## Allocation exacte préparée

Les fonctions de domaine utilisent des décimales exactes à douze positions. Chaque réception prend sa part du montant et de la quantité **restants** ; la dernière prend le reliquat exact. Une annulation restaure le montant original, et l'annulation d'une annulation le réapplique exactement. Aucun coût unitaire arrondi n'est multiplié pour reconstruire une valeur.

Ces fonctions n'écrivent pas encore d'allocations et ne sont pas raccordées au projecteur. Le prochain lot doit apporter le curseur net par base, les événements immuables, la preuve de parenté des inverses, les contrôles de quantité/OF/PT/version/propriétaire et l'écriture atomique avec l'entrée CUMP. L'interface Stock/Marges devra ensuite permettre de choisir et valider ces bases. Une base tardive ou une facture corrigée nécessite une correction financière explicite.

## Déploiement et vérification

Migration additive `20261008_stock_manufacturing_bases_998.sql`, avec préflight, vérification et rollback manuel refusant toute table non vide. Aucun backfill, aucune entrée financière ni activation CUMP. Sauvegarde complète et dumps séparés avant déploiement Test, Production HYPERBOX2 puis API publique.

TypeScript/build/OpenAPI et PREPARE/EXPLAIN des dix requêtes avec migration sous ROLLBACK sont les contrôles techniques prévus. Les scénarios métier, sécurité et concurrence restent **préparés, non exécutés**, pour la recette commune finale demandée. WP278 et #977 restent en cours.
