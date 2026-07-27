# Assistant d’import CLIPPER

## API

Toutes les routes sont sous `/api/v1/import-assistant` et réservées aux rôles `Administrateur Systeme et Reseau` et `Directeur`.

- `GET /capabilities`
- `POST /batches` avec `entity_type`, `source_system` et un fichier `file`
- `GET /batches/:id`
- `GET /batches/:id/rows`
- `PUT /batches/:id/preview`
- `POST /batches/:id/confirm` avec `Idempotency-Key`
- `GET /batches/:id/report.csv`

## Garanties

- Chaque requête vérifie `SELECT current_database()` et refuse l’opération avec
  `IMPORT_TEST_DATABASE_REQUIRED` si le processus n’est pas réellement connecté
  à `cerp_test`.
- CSV/XLSX uniquement, 25 Mo côté upload et 64 Mo décompressés.
- XLSX OOXML standard accepté avec ou sans préfixe d’espace de noms XML, y
  compris les noms de parties absolus internes comme `/xl/worksheets/sheet1.xml`.
  Les chemins relatifs sortants et les entrées ZIP dangereuses restent refusés.
- SHA-256 du fichier et unicité du lot par source, domaine, empreinte et feuille.
- Simulation par les schémas Zod existants.
- Création par les services métier existants et codes générés par CERP.
- Enrichissement client par PATCH parcimonieux : seuls les champs réellement
  mappés sont écrits, sans listes vides implicites.
- Contacts clients rattachés par le crosswalk du client parent, avec clé
  d’idempotence propre et validation obligatoire du prénom, nom et courriel.
- Un même courriel peut appartenir à des contacts de clients différents
  (adresse d’achats, de comptabilité ou de groupe partagée). L’unicité est
  contrôlée sans tenir compte de la casse ni des espaces, par client actif ;
  aucun courriel source ne doit être falsifié pour contourner un doublon.
- Le rattachement conserve le contrat historique `clients.client_id` /
  `contacts.client_id` en `varchar(3)` ; seul `contacts.contact_id` est un UUID.
  La reprise idempotente ne doit donc jamais convertir l’identifiant client en
  UUID.
- Crosswalk stable entre clé CLIPPER et fiche CERP.
- Reprise par lots de 25 lignes avec verrouillage `SKIP LOCKED`.
- Confirmation et création idempotentes.
- Audit de chaque étape et rapport ligne par ligne.
- Purge des données de staging après 90 jours ; métadonnées de preuve et crosswalk conservés.

## Base de données

Patches :

- `db/patches/20260726_import_assistant_167.sql` pour le socle ;
- `db/patches/20260727_import_clients_enrichment_306.sql` pour
  `CLIENT_ENRICHISSEMENT`, `CLIENT_CONTACT` et l’idempotence des contacts ;
- `db/patches/20260727_contacts_email_scope_187.sql` pour remplacer, uniquement
  dans `cerp_test`, l’unicité globale historique du courriel par une unicité
  normalisée au sein d’un même client actif.

Avant toute application, exécuter le preflight sur `cerp_test`, appliquer par le mécanisme de patches existant, puis lancer le script `verify`. Le rollback automatique est volontairement bloqué dès que des preuves ou correspondances peuvent exister.

Le patch est additif et n’importe aucune donnée métier.

## Ordre de reprise

Les lots sont exécutés dans l’ordre : clients complets, contacts clients,
fournisseurs, commandes fournisseurs, articles et matières achetés, machines et
référentiels, puis pièces techniques. Une pièce technique ne doit pas être
confirmée tant que ses clients, fournisseurs, matières et flux d’achat ne sont
pas validés.

Le choix affiché par le frontend n’est jamais utilisé comme preuve. Le service
API dédié à l’import doit disposer de son propre pool PostgreSQL vers
`cerp_test`; le middleware contrôle l’identité de cette connexion avant chaque
route de l’assistant. Un en-tête falsifié ou une erreur de routage ne peut donc
pas autoriser un import sur `cerp_prod`.

## Validation `cerp_test` du 2026-07-27

Une copie fraîche de `cerp_prod` a été construite dans une base temporaire,
vérifiée, patchée, puis renommée en `cerp_test`. L’ancienne base de test a été
conservée sous le nom `cerp_test_pre_import_167_20260727_0050`, avec les
connexions désactivées.

Contrôles réalisés :

- sauvegarde production vérifiée :
  `/var/backups/cerp/cerp_prod_20260727-003748.dump`, 39 332 092 octets,
  SHA-256 `9b88c29f37fe4a81f6370e7b89851976b9362c2524316e707106c911d7729707` ;
- sauvegarde de l’ancienne base de test vérifiée :
  `/var/backups/cerp/cerp_test_pre_refresh_20260727-0050.dump`,
  39 333 368 octets,
  SHA-256 `4e8d9d1bb8645fa4d4e2024ecfe81a2f9b809de98d6f45318ebee48ccde4b930` ;
- égalité exacte des nombres de lignes et des empreintes de contenu de toutes
  les tables entre la production sauvegardée et la copie, avant le patch ;
- égalité des séquences et objets volumineux ;
- preflight réussi, patch SHA-256
  `2527f82ac3e816b3b1289d8a5ba11d4d77ed4532ff369c76ebcd13ef8f57689a`
  appliqué et enregistré dans `cerp_schema_migrations` ;
- tous les contrôles du script `verify` sont vrais ;
- propriétaires, droits d’écriture et fonction de rétention vérifiés pour
  `cerp_app` ;
- smoke test transactionnel exécuté puis annulé, avec zéro ligne résiduelle ;
- connexion réelle avec les identifiants applicatifs vers `cerp_test`
  confirmée, sans exposer le secret ;
- empreinte de contenu de `cerp_prod` inchangée avant et après l’opération.

Ce premier clonage a révélé deux liens historiques orphelins dans
`article_category_link`. Cet état a ensuite été corrigé par le patch #168,
avant la reprise de l’intégration.

## Reconstruction après corrections #168 et #169

Le 2026-07-27, après réparation des deux liens orphelins et validation des trois
références historiques vers `articles_fabrique`, `cerp_test` a été reconstruite
une seconde fois depuis la production corrigée.

- sauvegarde source :
  `/var/backups/cerp/cerp_prod_20260727-020006.dump`,
  39 332 474 octets, SHA-256
  `84a63ded269c134a1ad83e6dc734d2afe0547809c276697cfa3e6f80aa6bed2b` ;
- sauvegarde de la base de test remplacée :
  `/var/backups/cerp/cerp_test_pre_refresh_168_169_20260727-0200.dump`,
  39 375 039 octets, SHA-256
  `5fdb2ce53b4b665c68fdf799653f0a920db194dad23027d7f695f81d23f68f5f` ;
- ancienne base conservée sous
  `cerp_test_pre_import_167_168_169_20260727_0200`, connexions désactivées ;
- égalité exacte des volumes et empreintes des 303 tables entre `cerp_prod` et
  la nouvelle `cerp_test` avant réapplication du patch #167 ;
- patch #167 réappliqué avec l’empreinte
  `2527f82ac3e816b3b1289d8a5ba11d4d77ed4532ff369c76ebcd13ef8f57689a`
  et enregistré dans `cerp_schema_migrations` ;
- vérification structurelle complète réussie ;
- connexion réelle du rôle applicatif `cerp_app`, droits d’écriture et droit
  d’exécution de la fonction de rétention confirmés sans exposer le secret ;
- smoke test du lot, d’une ligne, du crosswalk et de l’idempotence entièrement
  annulé, avec zéro résidu ;
- aucune clé étrangère publique non validée et aucun lien de catégorie
  d’article orphelin.
