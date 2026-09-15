# Couverture matière du planning central — #963

Livraison locale du 14 septembre 2026, branche `feature/963-planning-coverage`
issue de `origin/dev` (`8e24d156`). Ticket frontend #963, rattachement backend #717,
Project Office `CERP / PLANNING-CENTRAL-20260906-P3`.

## Contrat et sources de vérité

`GET /api/v1/planning/v2/snapshot` conserve `apiVersion: 2`. Le contrat déclare
`coverageAvailable`. Il est faux si le parcours matière n’est pas activé, vrai
si les besoins matière des OF de la page ont été lus. Une erreur de lecture
reste une erreur HTTP ; elle ne devient pas un besoin nul.

Le lecteur réutilise `readMaterialTx` : besoins de la définition OF, réservations,
achats affectés, appels de matière client, réceptions, conversions, rapprochements
de révisions et propositions de réservation. La même vérification des lots réservés
est partagée par le planning et le contrôle de démarrage des opérations. Aucun prix,
document fournisseur, secret ou nouvelle autorisation de démarrage n’est exposé.

Les `demands` portent la quantité totale et une synthèse `coverage`, identifiée
par OF et opération consommatrice. Un besoin non rattaché reste visible avec son
blocage de préparation. La rubrique concerne la matière configurée dans le parcours
OF (achetée ou fournie par le client) ; elle n’invente pas de besoin à partir d’un
stock de pièces finies, d’un consommable partagé ou d’une opération fournisseur.

Les `sources` sont des **parts de preuve**, pas des totaux de magasin à additionner :

| Part | Quantité publiée | Effet prévisionnel |
| --- | --- | --- |
| Réservation physique | Réservé actif non consommé, non expiré | Seulement si le lot est compatible et libéré |
| Achat / appel attendu | Affecté moins reçu | Seulement confirmé, compatible et avec une date utilisable |
| Réception à libérer / affecter | Reçu moins transféré vers une réservation | Bloque tant que le besoin n’est pas sécurisé |
| Brouillon | Reste affecté sur achat non envoyé ou appel non annoncé | Hypothèse, jamais une date fiable |
| Libre (`scope: FREE`) | Proposition du module matière / solde futur global | Aucune allocation créée, aucune date garantie |

Les `allocations` représentent uniquement les parts déjà affectées. Leurs quantités
ont déjà été séparées entre futur, reçu non transféré et réservation ; leur
`transferredQuantity` vaut donc zéro. Les identifiants incluent la part pour empêcher
une réception de figurer simultanément dans le futur et dans la réservation physique.
`ownerClientId` complète les preuves ; il ne remplace pas une vérification métier.

`missing` et `toPrepare` reprennent respectivement le manque sans engagement et le
manque après proposition physique du module matière. Les brouillons et réceptions
bloquées restent des engagements à traiter, pour éviter un deuxième achat.
`unsecured` distingue la quantité non sécurisée par du physique utilisable ou une
affectation future compatible. Les dates dépassées / absentes restent des alertes.

## Concurrence, qualité et prévision

La lecture HTTP est une transaction `REPEATABLE READ READ ONLY`. Chaque OF n’est
chargé qu’une fois par page. Les lecteurs canoniques déduisent les réservations de
tous les OF et calculent les intervalles de réception avant de filtrer l’OF demandé.
Les propositions libres sont partagées : les afficher dans deux OF ne constitue
pas deux réservations. Le parcours existant revalide avant confirmation.

Les réceptions annulées sont exclues des quantités reçues, aussi bien dans le module
matière que dans les sources futures et les appels client. Les achats / affectations
annulés étaient déjà exclus. Les unités, propriétaire, article et destination doivent
rester compatibles ; la quarantaine invalide l’usage d’un lot même déjà réservé.

Le worker réutilise cette projection et la file d’invalidation existante. Il lit
le snapshot sans couverture, puis partage sa lecture matière avec le contrôle
d’opération pour éviter de recalculer deux fois les mêmes données. Seuls les champs
`forecast_*` sont écrits. Un achat attendu après le début engagé décale la prévision ;
aucune date engagée, réservation, affectation de machine ou déclaration n’est modifiée.
Une réception bloquée en surplus ne retarde pas un besoin déjà entièrement sécurisé.

## Vérifications locales

- Suite backend complète : **488 fichiers, 5 743 tests réussis**, 78 tests opt-in ignorés
  lors de cette exécution générale. Les derniers ajustements de réception annulée et
  d’éligibilité ont ensuite été couverts par **297 tests ciblés réussis**.
- PostgreSQL 18.6 jetable, 231 patches existants appliqués sans écart de checksum,
  seed synthétique SOL-05 : **14 tests PostgreSQL réussis**. Comparaison exacte
  planning / `readMaterialTx`, réception de 40 attribuée à l’OF masqué, solde libre
  global, pagination, affectation concurrente entre deux transactions, date modifiée,
  annulation d’affectation et de réception, invalidation durable.
- Tests de projection : 30 réservés + 70 attendus le 20 face à un début le 18,
  réception partielle puis transfert, quarantaine, brouillons, conversion d’achat,
  article/unité/propriétaire/destination incompatibles, date absente/dépassée et
  calcul au millième. Tests spécifiques du contrôle des réservations ajoutés.
- TypeScript et contrat OpenAPI compilés ; frontières de données de production
  vérifiées. Le code n’ajoute aucune migration ni dépendance.

Recette PostgreSQL locale : `CERP_E2E_ISOLATED=1`,
`CERP_PLANNING_COVERAGE_PG=1`,
`DATABASE_URL=postgresql://cerp_e2e@127.0.0.1:5197/cerp_test`, puis
`node node_modules/vitest/vitest.mjs run src/module/planning/repository/planning-central.postgres.test.ts`.
Cette variante vérifie aussi le répertoire serveur `/tmp/cerp-planning-963-pg`.
Le port 5197 a servi de relais local vers la base WSL : Windows réserve les ports
55432 et 55636 sur ce poste. Aucune connexion aux bases métier n’a été utilisée.
La recette ne mesure pas encore les performances sur un volume représentatif de production.

## Ordre de livraison

1. Intégrer / livrer ce backend compatible avec l’ancien frontend.
2. Intégrer / livrer l’inspecteur frontend de la même branche fonctionnelle.
3. Réaliser séparément la recette métier et l’activation en production avec les
   indicateurs existants (`PRODUCTION_MATERIAL_WORKFLOW`, niveau du planning).

Pas de push, migration de production, déploiement ou activation dans cette livraison
locale. Le partage de production entre plusieurs OF et les transferts depuis le
planning restent différés. Le Project Office doit recevoir ce rapport au passage
en revue ; les variables d’accès du helper n’étaient pas configurées dans la session.
