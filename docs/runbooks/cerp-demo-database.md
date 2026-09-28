# CERP-DEMO-01 — instance de démonstration isolée

La démo est une instance CERP distincte. Elle ne doit jamais sélectionner une
base depuis le navigateur : le conteneur API reçoit une unique `DATABASE_URL`
vers `cerp_demo` et démarre seulement avec `CERP_DEMO_MODE=true`.

## État validé — 28 septembre 2026

L'instance publique HTTPS `https://demo-cerp.croix-rousse-precision.fr/api/v1` a été
recettée le 28 septembre 2026. La base `cerp_demo` contient **562 tables**
clonées en **schéma seul** : aucun compte ni aucune donnée métier de production
ou de test n'ont été restaurés.

La recette du parcours guidé C a validé, dans cette seule base, la création
d'un client, devis, commande, affaire de livraison, OF, créneau et pointage,
jusqu'à la clôture opérateur. L'affaire publiée par le parcours est celle
attachée à l'OF de livraison, et non l'affaire commerciale principale.

La recette authentifiée a validé la connexion visiteur, les lectures des
modules autorisés et la création d'un devis JSON pour le client synthétique
`003` (référence `DEMO0928A`). Le devis créé est `BROUILLON` et ses totaux
calculés sont `0` lorsqu'il ne contient aucune ligne facturable. Ce résultat
est une preuve de fonctionnement de l'environnement démo, pas un jeu de
données à réutiliser dans une autre base.

L'accès PostgreSQL est séparé au niveau réseau et des rôles : la règle HBA de
la démo n'autorise que son service API, le rôle propriétaire ne permet pas de
connexion (`NOLOGIN`) et le rôle applicatif ne reçoit aucun héritage implicite
(`NOINHERIT`). Les rôles et règles HBA de `cerp_prod` et `cerp_test` refusent
toute utilisation par ce service. Ne jamais remplacer cette séparation par une
sélection de base fournie par un client HTTP.

## Variables de déploiement

- `CERP_DEMO_MODE=true`
- `DATABASE_URL` vers la seule base `cerp_demo`
- `JWT_SECRET` distinct de toute autre instance
- `CORS_ORIGINS` limité à l'origine du frontend de démonstration
- `FRONTEND_URL` de la démo
- `DEMO_SEED_PASSWORD` pour le seed et le processus API de démo, côté serveur uniquement
- `DEMO_SEED_USERNAME` facultatif, `DEMO` par défaut
- `AUTH_RATE_LIMIT_HASH_KEY` (au moins 32 caractères), distinct et conservé côté serveur

Le backend refuse au démarrage une URL `cerp_demo` sans mode démo, ou un mode
démo relié à une autre base. Il désactive les sockets et les maintenances de
fond en démo. Les documents, emails, intégrations, exports, utilisateurs,
administration et suppressions sont refusés par le garde API.

## Prévol de mise en ligne

Avant chaque redéploiement, exécuter ces contrôles avec le compte PostgreSQL
de maintenance de la démo, sans afficher d'URL ni de secret dans les journaux :

```sql
SELECT current_database();
SELECT count(*) AS public_table_count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
SELECT rolname, rolcanlogin, rolinherit
FROM pg_roles
WHERE rolname IN ('cerp_demo_owner', 'cerp_demo_app');
```

Le premier résultat doit être `cerp_demo`; le second doit être `562` pour la
référence validée du 28 septembre 2026. Adapter les deux noms de rôle au
provisionnement réel, mais conserver les propriétés `NOLOGIN` du propriétaire
et `NOINHERIT` de l'application. Vérifier aussi que `CORS_ORIGINS` ne contient
que l'origine HTTPS de la vitrine et que l'API ne publie aucun port ou route de
l'instance de production.

## Schéma et données

Le bootstrap `db/e2e/legacy-bootstrap.sql` est réservé à la recette jetable :
il cible explicitement `cerp_test` et son schéma historique est réduit. Il ne
doit pas alimenter une démo durable.

Créer `cerp_demo` à partir d'un export **schema-only** validé de la base de
test CERP, sans données métier ni comptes. Vérifier le catalogue restauré,
appliquer seulement les patches confirmés absents, puis lancer :

```text
node scripts/seed-demo-account.js
node scripts/seed-demo-module-catalog.js
node scripts/seed-showcase-data.js
node scripts/seed-demo-presentation.js
```

Les deux scripts exigent une URL `cerp_demo`; le mot de passe du compte démo
vient exclusivement de l'environnement. `seed-showcase-data.js` est offline :
il ne démarre pas l'API et n'utilise ni HTTP ni jeton. Il vérifie d'abord le
compte `DEMO_SEED_USERNAME` (ou `DEMO` par défaut) et le schéma, puis ajoute dans une transaction deux clients
synthétiques, un fournisseur, un article matière, un magasin, un emplacement
et un solde de stock. Il est idempotent à partir de ses identifiants `DEMO`.

`seed-demo-module-catalog.js` ajoute uniquement les entrées de navigation des
espaces autorisés dans `app_modules`; il ne crée ni rôle applicatif, ni override
nominatif, ni donnée métier. Le compte garde le rôle `Directeur` et le marqueur
`is_superadmin=false`. Avant toute réexécution, vérifier que le compte DEMO ne
porte aucun facteur MFA actif : un facteur actif impose une vérification MFA et
ces routes restent volontairement fermées dans la démonstration.

`seed-demo-presentation.js` ajoute les seules références synthétiques du
parcours de présentation : versions techniques applicables, gammes, opérations,
famille machine, centre de frais et calendrier. Il ne crée aucun scénario
visiteur, document ou contrôle qualité. Chaque visite crée ses propres client,
devis, commande, affaire, OF et pointage via le backend.

Le registre additif `db/patches/support/20260928_cerp_demo_presentation.sql`
est appliqué manuellement après sauvegarde, **uniquement** sur `cerp_demo`.
Il crée les scénarios et leurs reçus d'idempotence; son garde `current_database()`
refuse toute autre base. Il ne fait pas partie du ledger global de migrations
des instances métier : conserver le SHA du fichier appliqué dans le journal de
déploiement de la démo avec la sauvegarde correspondante.

Pour le parcours natif v3, appliquer ensuite, toujours après sauvegarde et sur
`cerp_demo` seulement, `20260928_cerp_demo_native_presentation_v3.sql` puis
`20260928_cerp_demo_presentation_start_key.sql`. Le second patch retire la
contrainte historique d'un seul scénario actif par compte sans effacer de
scénario : chaque onglet reprend exclusivement la même paire compte + clé de
démarrage. Le verrou applicatif par compte et la limite de 30 nouveaux
scénarios par heure restent en place.

## Connexion visiteur

Le bouton visiteur appelle `POST /api/v1/auth/demo/login` avec l'en-tête exact
`X-CERP-Database: cerp_demo`, sans envoyer de nom d'utilisateur, mot de passe
ni jeton prédéfini. La route n'existe qu'avec `CERP_DEMO_MODE=true`, passe par
le limiteur de connexion PostgreSQL et utilise les identifiants de seed présents
uniquement dans l'environnement du processus. Sa réponse est strictement le
format de `POST /api/v1/auth/login`; le frontend vérifie ensuite
`GET /api/v1/environment` avec le Bearer token et le même en-tête.

La seule écriture métier directe exposée est la création d'un devis brouillon par
`POST /api/v1/devis` avec un corps JSON et `statut` égal à `BROUILLON` (ou
`DRAFT`). Les formulaires multipart et tous fichiers sont refusés avant le
middleware d'upload; les transitions, révisions, conversions et suppressions
restent fermées.

Le parcours guidé authentifié `POST /api/v1/demo/presentation/run` est une
exception bornée, réservée au scénario synthétique et au registre
`demo_presentation_scenarios`. Il orchestre les services métier existants pour
adopter un client et un devis créés par les formulaires natifs, puis créer une
commande, une affaire, un OF, son créneau et un pointage. Il demande une clé
d'idempotence et l'en-tête
`X-CERP-Database: cerp_demo`, limite les nouveaux scénarios et refuse les
actions concurrentes. Les actions de suppression, d'administration,
d'intégration, d'email, de fichier et de paiement restent interdites.

Le démarrage opérateur effectue une libération OF explicite et auditée. Comme
la démo n'expose ni dépôt documentaire ni contrôle qualité, une dérogation
contrôlée peut être enregistrée uniquement si les preuves manquantes sont un
sous-ensemble non vide de `PROGRAM_OR_INSTRUCTION_MISSING` et
`QUALITY_PLAN_MISSING`. Cette dérogation ne valide pas la qualité et tout autre
bloqueur opérationnel, matière, capacité ou technique reste refusé.

Les lectures complémentaires strictement nécessaires au formulaire de devis
sont limitées aux chemins exacts `GET /billers`, `GET /payment-modes`,
`GET /conditions-paiement`, `GET /compte-vente` et
`GET /service-status/documents`. Aucun sous-chemin de ces routes n'est ouvert;
en particulier, les téléchargements et documents restent refusés.

`GET /operational-media/capabilities` est également ouvert, uniquement pour
permettre au formulaire d'afficher l'état désactivé des médias. En démo il
renvoie un contrat statique sans sonde de stockage, fichier temporaire,
antivirus ou intégration; les aperçus, téléchargements et promotions d'uploads
restent tous désactivés.

### Recette HTTP post-déploiement

Depuis un poste autorisé, utiliser l'URL HTTPS publique de la démo dans
`DEMO_API_BASE_URL` (sans la stocker dans le frontend ni dans ce dépôt) :

```text
POST ${DEMO_API_BASE_URL}/auth/demo/login
X-CERP-Database: cerp_demo

GET ${DEMO_API_BASE_URL}/environment
Authorization: Bearer <jeton retourné>
X-CERP-Database: cerp_demo

POST ${DEMO_API_BASE_URL}/devis
Authorization: Bearer <jeton retourné>
X-CERP-Database: cerp_demo
Idempotency-Key: <clé unique>
Content-Type: application/json

POST ${DEMO_API_BASE_URL}/demo/presentation/run
Authorization: Bearer <jeton retourné>
X-CERP-Database: cerp_demo
Idempotency-Key: <clé unique>
Content-Type: application/json
```

Pour le parcours, envoyer un corps `{"action":"start"}` puis les actions
renvoyées dans `next_action`, avec une nouvelle clé d'idempotence à chaque
étape. Attendre un refus `403`
pour un upload multipart, une suppression, un export/document, un portail,
une intégration ou toute écriture hors devis brouillon.

Le seed de présentation ne crée pas de documents, contrôles qualité, factures,
paiements, intégrations ou comptes supplémentaires. Aucune
restauration, migration ou connexion à une base existante n'est effectuée par
ce dépôt.
