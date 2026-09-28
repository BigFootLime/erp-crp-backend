# CERP-DEMO-01 — instance de démonstration isolée

La démo est une instance CERP distincte. Elle ne doit jamais sélectionner une
base depuis le navigateur : le conteneur API reçoit une unique `DATABASE_URL`
vers `cerp_demo` et démarre seulement avec `CERP_DEMO_MODE=true`.

## État validé — 28 septembre 2026

L'instance publique HTTPS `https://demo-cerp.croix-rousse-precision.fr/api/v1` a été
recettée le 28 septembre 2026. La base `cerp_demo` contient **562 tables**
clonées en **schéma seul** : aucun compte ni aucune donnée métier de production
ou de test n'ont été restaurés.

Le déploiement Backend03 correspondant est sain sur cette URL, avec l'image
`sha256:ef31301a1a92f08364f0c9eed4f54bddfa9442a06464ed1ce758ae43ed742c17`.

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

## Connexion visiteur

Le bouton visiteur appelle `POST /api/v1/auth/demo/login` avec l'en-tête exact
`X-CERP-Database: cerp_demo`, sans envoyer de nom d'utilisateur, mot de passe
ni jeton prédéfini. La route n'existe qu'avec `CERP_DEMO_MODE=true`, passe par
le limiteur de connexion PostgreSQL et utilise les identifiants de seed présents
uniquement dans l'environnement du processus. Sa réponse est strictement le
format de `POST /api/v1/auth/login`; le frontend vérifie ensuite
`GET /api/v1/environment` avec le Bearer token et le même en-tête.

La seule écriture métier exposée est la création d'un devis brouillon par
`POST /api/v1/devis` avec un corps JSON et `statut` égal à `BROUILLON` (ou
`DRAFT`). Les formulaires multipart et tous fichiers sont refusés avant le
middleware d'upload; les transitions, révisions, conversions et suppressions
restent fermées.

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
```

Le dernier appel doit contenir `statut: "BROUILLON"` et des lignes valides ou
être traité selon les règles métier du formulaire. Attendre un refus `403`
pour un upload multipart, une suppression, un export/document, un portail,
une intégration ou toute écriture hors devis brouillon.

Ce seed ne couvre pas les devis, affaires, ordres de fabrication, documents,
factures, paiements, intégrations ou comptes supplémentaires. Aucune
restauration, migration ou connexion à une base existante n'est effectuée par
ce dépôt.
