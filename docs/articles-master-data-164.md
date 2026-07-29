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

## Complément — règles matière et Stock restantes (2026-07-29)

Le patch additif `20260729_articles_164_remaining_rules.sql` complète le
référentiel existant sans créer de table Article ni de moteur de finitions
parallèle :

- profils matière canoniques `PL`, `RO`, `U`, `FOND`, `TUBE`, `PROFIL`,
  `BRUTCL`, avec normalisation des liens historiques ;
- propriétaire du brut client ;
- longueurs distinctes de barre source, de coupe et de brut, plus quantité
  linéaire totale au niveau Article et lot ;
- prix fournisseur qualifié par une base exclusive `NONE`, `KG` ou `M` dans
  `fournisseur_catalogue` et son historique ;
- densité publique et canonique en kg/m³ dans `densite_kg_m3`, tout en
  maintenant la colonne historique `densite` en kg/dm³ par synchronisation
  (`7,85 × 1 000 = 7 850`).

L'audit en lecture seule n'a trouvé aucune densité historique renseignée :
une nuance sans densité dans `cerp_test`, aucune nuance dans `cerp_prod`.
Le choix additif évite néanmoins qu'un ancien consommateur interprète une
valeur convertie dans la mauvaise unité.

Le chemin Stock pour un Article de traitement réutilise
`surface-finish-resolution.repository.ts`, la spécification canonique, la
génération de textes et l'idempotence de #210. Il exige PT et version, crée
uniquement un Article `EN_DEVIS`, n'écrit ni achat, ni gamme, ni mouvement de
stock, puis laisse la validation/mise en production à une capacité séparée.

Scripts d'exploitation :

1. `support/20260729_articles_164_remaining_rules.preflight.sql` ;
2. `20260729_articles_164_remaining_rules.sql` ;
3. `support/20260729_articles_164_remaining_rules.verify.sql` ;
4. rollback structurel uniquement sur `cerp_test`, avant toute utilisation des
   nouveaux champs.

Validation du 29 juillet 2026 sur `cerp_test` :

- sauvegarde dédiée
  `/var/backups/cerp/cerp_test_pre_164_20260729-2253.dump`, 38 752 526 octets,
  3 780 entrées de catalogue, SHA-256
  `d37779782eb82476c8f1bf8818e016b61d3963b0313e24933748063007bf2b01` ;
- préflight entièrement vert ;
- application, verify, rollback protégé, réapplication et second verify réussis ;
- 272 Articles matière, 0 lot, 233 lignes de mouvement et 0 prix fournisseur
  avant/après ;
- patch enregistré avec le SHA-256
  `ecf89b47af9d62fe96642c232aad75a64f6414071fad7d3e5b4416d8658e1236`.

La migration de production reste une décision humaine distincte. Le patch n'a
pas été appliqué à `cerp_prod`.
