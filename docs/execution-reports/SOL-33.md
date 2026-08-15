# SOL-33 — Centre des données de référence

- Date d'exécution : 2026-08-15 (Europe/Paris)
- Propriétaire : Keenan Martin
- Issues : backend `#529`, frontend `#737`
- Branche backend : `feature/529-reference-data-center`
- Branche frontend : `feature/737-reference-data-center`

## Diagnostic et cause racine

Les valeurs critiques existaient dans leurs domaines, mais leur gouvernance
était fragmentée : écrans et APIs séparés, comparaison non uniforme, pas de
file commune d'approbation, et aucune empreinte empêchant d'appliquer une
proposition devenue obsolète. Les snapshots métiers étaient parfois confondus
avec des paramètres maîtres.

La solution conserve chaque source canonique et ajoute un plan de contrôle
commun. L'ADR-0079 et `docs/release/REFERENCE_DATA_GOVERNANCE.md` consignent la
frontière, les propriétaires et l'inventaire des valeurs dispersées.

## Changements livrés

- migration additive SOL-33 avec propositions, versions immuables et décisions
  append-only ;
- preflight, post-vérification et rollback gardé ;
- API `/api/v1/admin/reference-data` : capacités, catalogue, détail, comparaison,
  import/export, proposition, décision et application ;
- RBAC serveur, quatre yeux, idempotence et contrôle de concurrence SHA-256 ;
- validation des unités, conversions, dates, chevauchements, calendriers,
  dépendances et doublons ;
- interface fonctionnelle Administration → Données de référence, sans retouche
  graphique finale ;
- tests unitaires, intégration DB, RBAC, contrats frontend et migration.

## Migrations et données

Le patch `20260815_reference_data_center_sol33.sql` est additif. Il ne crée et ne
modifie aucune valeur métier. La répétition isolée a migré une base complète de
140 à 163 patches, puis rejoué zéro patch. La sauvegarde/restauration du banc a
réussi. Une répétition d'intégration supplémentaire a appliqué le patch, chargé
le seed déterministe et exécuté le workflow quatre yeux sur une base jetable.

Le premier essai global a révélé que le preflight référençait l'ancien nom
`audit_logs`. Il a été corrigé vers `erp_audit_logs`, puis toute la répétition a
réussi. Le SHA-256 canonique du patch est enregistré dans le runner immuable.

## Tests exécutés avant promotion

- backend typecheck : réussi ;
- suite backend complète : 1 048 suites, 4 761 tests réussis, 8 tests
  d'intégration explicitement ignorés hors environnement isolé, zéro échec ;
- tests ciblés SOL-33 + runner : 28 réussis ;
- intégration PostgreSQL isolée : 2 réussis, incluant rejeu idempotent,
  auto-approbation refusée, application transactionnelle et source concurrente
  refusée ; après ajout du contrôle de dépendance, répétition sur une base neuve :
  3 réussis, dont l'unité inconnue refusée avant proposition ;
- répétition migrations : réussie, restauration réussie, rejeu sûr ;
- build backend : réussi, 1 069 opérations OpenAPI inventoriées à 100 %, contrat
  valide et 737 fichiers source/émis conformes à la frontière production ;
- frontend typecheck et lint : réussis ;
- suite frontend complète après correctifs : 298 fichiers et 2 508 tests
  réussis en 93,80 s ;
- build frontend : réussi, 11 887 modules sur la pile E2E et frontière production
  validée ; les avertissements de taille des chunks sont préexistants ;
- Playwright isolé : 1 scénario réussi en 6,3 s. Il couvre rendu administrateur,
  source/fiabilité, validation de dépendance en 422, responsive desktop/tablette
  et refus 403 d'un utilisateur standard.

Le premier passage Playwright a échoué sur un sélecteur ambigu qui trouvait le
même titre dans la carte et le panneau ; la capture montrait l'écran correct.
Le sélecteur a été resserré sur le rôle de titre, puis le scénario a réussi sur
une base jetable neuve. Aucun timeout ni assertion métier n'a été assoupli.

## Promotion Git

- commit fonctionnel backend :
  `1e26f9bf27c47239aae911b2d7c21906a5e31b1f` ;
- PR backend feature vers `dev` : `#530`, fusionnée ;
- PR backend `dev` vers `main` : `#531`, SHA
  `3dc4471abdfe100d9221a9f112c52cf103d1dab0` ;
- commit fonctionnel frontend :
  `c0e1f8fe7665073913e4f76b9bffe7a05512772b` ;
- PR frontend feature vers `dev` : `#738`, fusionnée ;
- PR frontend `dev` vers `main` : `#739`, SHA
  `000f6edad3af970d016a6fb7961c5123cfc72d6f`.

Les branches officielles locales `dev` et `main` des deux dépôts ont été
avancées en fast-forward jusqu'aux références distantes et vérifiées propres.
Les arbres locaux historiques non liés à SOL-33 n'ont pas été modifiés.

## Sauvegarde, migration et restauration réelles

Le preflight a été exécuté sur `cerp_test` et `cerp_prod` : PostgreSQL 17.10,
espace disponible, rôle `cerp_app`, tables prérequises et données invalides
contrôlés. Tous les prérequis SOL-33 étaient verts et les trois tables cibles
étaient absentes.

Sauvegardes pré-migration conservées hors du répertoire applicatif :

- `cerp_test_pre_sol33_20260815-081709.dump`, 73 136 508 octets, SHA-256
  `e4a81d043a47866c9a051fcd4e723bbee247367169482fae8a4f2c353e6a8e1a` ;
- `cerp_prod_pre_sol33_20260815-081709.dump`, 49 665 530 octets, SHA-256
  `773f8ccf38f71aa3faa9b288fa3edaf9545140b0cccd26edd1d0a05fc5e00765`.

Les deux archives sont en mode `0600`, leur inventaire `pg_restore` est valide.
La sauvegarde de test a été restaurée dans la base jetable
`cerp_sol33_restore_20260815`, puis le preflight complet y a réussi ; la base et
la copie temporaire ont ensuite été supprimées.

Le runner immuable a appliqué uniquement
`20260815_reference_data_center_sol33.sql`, d'abord sur `cerp_test`, puis sur
`cerp_prod`. Les deux vérifications post-migration confirment tables, triggers,
droits et zéro chevauchement. Aucun paramètre métier n'a été créé. Le rejeu sur
chaque base a appliqué zéro patch.

## Déploiements et preuves live

- HYPERBOX2 : archive Git SHA-256
  `ed9918695b174e45b6f7b4962ebebe3fc998b38a5e23ec1764f106709b7bdd6c`,
  release immuable `/srv/cerp/releases/20260815-3dc4471` ; services
  `cerp-api-test` et `cerp-api` actifs et prêts sur les ports 8082 et 8080 ;
- les deux readiness HYPERBOX2 publient le SHA backend complet et mesurent DB,
  GED, antivirus et realtime `up` ; la route anonyme du centre répond `401` ;
- Coolify backend : déploiement webhook `p13kmu34ypqstvvwn1754voi`, réussi de
  06:14:24 à 06:20:26 UTC, application `healthy` au SHA `3dc4471…` ;
- Coolify frontend : déploiement webhook `x32agxx267sbxli3qne5itke`, réussi de
  06:14:23 à 06:16:32 UTC, application `healthy` au SHA `000f6eda…` ;
- smoke public : readiness backend `200`, route anonyme `401`, page
  `/administration/reference-data` `200`, et bundle frontend contenant le SHA
  complet `000f6edad3af970d016a6fb7961c5123cfc72d6f`.

## Risques, compatibilité et rollback

Les consommateurs existants restent compatibles car aucune source canonique
n'est déplacée. Les anciennes lignes et snapshots ne sont pas recalculés. Les
tables spécialisées SOL-13/SOL-19 sont affichées comme indisponibles si leur
patch historique n'est pas encore présent sur une instance.

Avant toute preuve SOL-33, le rollback SQL peut supprimer les objets ajoutés.
Dès qu'une proposition ou décision existe, le script refuse et impose la
restauration du dump pré-migration dans une base neuve. Un rollback applicatif
peut redéployer le SHA précédent tout en conservant les tables additives.

## Reste réellement à faire

Aucun reliquat fonctionnel SOL-33 connu. Les valeurs réelles restent à saisir
par leurs propriétaires via le workflow gouverné ; les inventer ou les charger
automatiquement aurait contredit le contrôle métier. Ce complément documentaire
est promu séparément et ne modifie ni runtime ni schéma.
