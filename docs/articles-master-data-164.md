# Articles — référentiel maître (#164)

## Décision de source de vérité

`public.articles` reste la source de vérité Article. Aucune table `article_master` parallèle n’est créée. Le code métier est réservé exclusivement par le serveur au format `ART-{FAM}-{SEQ6}` et devient immuable après insertion.

Une version ou un indice technique appartient à `piece_technique_versions`. L’Article lié garde la même identité ; l’API expose seulement sa version technique actuellement applicable et l’historique des versions de la Pièce.

## Contrat HTTP

| Méthode | Route | Usage |
|---|---|---|
| `GET` | `/api/v1/stock/articles` | Recherche, filtres, tri et pagination serveur |
| `POST` | `/api/v1/stock/articles` | Création idempotente ; en-tête `Idempotency-Key` obligatoire |
| `GET` | `/api/v1/stock/articles/:id` | Fiche enrichie, approvisionnement, fournisseurs, documents |
| `PATCH` | `/api/v1/stock/articles/:id` | Modification avec `expected_row_version` obligatoire |
| `POST` | `/api/v1/stock/articles/:id/archive` | Archivage si aucun usage métier n’existe |
| `POST` | `/api/v1/stock/articles/:id/reactivate` | Réactivation contrôlée |
| `GET` | `/api/v1/stock/articles/:id/versions` | Versions techniques de la Pièce liée |
| `GET` | `/api/v1/stock/articles/:id/where-used` | Nomenclatures, devis, commandes, OF, réceptions, lots, mouvements, livraisons |
| `GET/POST/DELETE` | `/api/v1/stock/articles/:id/documents[...]` | Documents validés et retrait logique traçable |

Le client ne peut envoyer `code` ni le modifier. Les écritures concurrentes retournent `409 ARTICLE_VERSION_CONFLICT`. Une clé d’idempotence réutilisée avec un autre contenu retourne `409 IDEMPOTENCY_KEY_REUSED`. L’archivage d’un Article utilisé retourne `409 ARTICLE_IN_USE` avec le nombre d’usages.

## Sécurité et données sensibles

- Lecture : utilisateur authentifié.
- Écriture Article et documents : Directeur, Administrateur Système et Réseau, Secrétaire, Responsable Programmation, Responsable Qualité.
- Archivage/réactivation : Directeur et Administrateur Système et Réseau.
- Coûts fournisseurs : Directeur, Administrateur Système et Réseau et Secrétaire ; les autres rôles reçoivent des montants et devises à `null` avec `costs_redacted=true`.
- Documents : dix fichiers maximum, 25 Mio chacun, extension/MIME/signature cohérents. Les chemins de stockage ne sont jamais exposés par l’API.
- Toutes les créations, modifications, archives, réactivations et opérations documentaires alimentent le journal d’audit.

## Base de données et exploitation

Le patch additif est `db/patches/20260722_articles_164_master_data.sql`. Les scripts de préflight, vérification et rollback sont dans `db/patches/support/` ; préflight et rollback refusent toute base autre que `cerp_test`.

La migration n’a pas été exécutée depuis ce workspace : aucun `DATABASE_URL` de test n’est configuré. Aucun accès à `cerp_prod` n’a été tenté. Procédure de validation :

1. charger explicitement les identifiants de `cerp_test` ;
2. exécuter le préflight ;
3. appliquer le patch avec le registre `cerp_schema_migrations` ;
4. exécuter le script de vérification ;
5. tester création répétée avec la même clé, conflit de version, archivage utilisé et masquage des coûts.

## Couverture automatisée

`article-master-data-164.test.ts` couvre 125 scénarios de validation, auxquels s’ajoutent les tests de routes stock et de lien Article/Pièce. Le build TypeScript constitue le contrôle de contrat transversal.
