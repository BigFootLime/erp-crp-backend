# Codification, versions techniques, snapshots OF et fichiers VSM

> Issue frontend : `crp-systems-web#141`  
> Patch : `db/patches/20260713_codification_versions_of_vsm.sql`

## Autorité et allocation

Le backend est l'unique autorité des codes métier. Les requêtes de création ne doivent pas fournir
de code final pour les articles, devis, commandes, affaires, OF, lots ou contrôles qualité ; une
valeur manuelle provoque une erreur de validation. Les références existantes restent lisibles.

`fn_next_issued_code_value(scope)` utilise une séquence PostgreSQL native partagée entre les scopes
autorisés. `nextval` n'est pas annulé par un rollback : un numéro abandonné crée un trou et ne sera
jamais réattribué. La largeur numérique des formats est une largeur minimale, pas une limite.

## Formats couverts

| Objet | Format serveur |
| --- | --- |
| Article | `ART-FAMILLE-NNNNNN` |
| Devis | `DEV-AAAA-NNNN` |
| Commande | `CMD-AAAA-NNNN` |
| Affaire | `AFF-AAAA-NNNN` |
| OF | `OF-AAAA-NNNNNN` |
| Lot | `LOT-AAAA-NNNNNN` |
| Contrôle qualité | `CQ-AAAA-NNNNNN` |

La pièce technique est normalisée à partir du client, du plan et de l'indice externe. Les numéros
légaux de facture restent au format `FT-…`; le mouvement de stock conserve son mécanisme historique.

## Versions techniques et OF

- `GET /api/v1/pieces-techniques/code-preview` : aperçu non réservant.
- `POST /api/v1/pieces-techniques/:id/versions/:versionId/create-next` : clone la définition courante
  (champs de version, opérations, gamme et nomenclature) dans une nouvelle version modifiable.
- `POST /api/v1/pieces-techniques/:id/versions/:versionId/publish` : publication guidée atomique.
  Un brouillon passe par la validation puis devient Applicable dans la même transaction ; une version
  déjà en validation devient Applicable et un rejeu sur l'indice déjà Applicable est idempotent. Le
  déclassement de l'ancien indice et le gel des exigences documentaires font partie de la transaction.
  `expected_updated_at` protège des modifications concurrentes. `date_effet: null`, envoyé
  explicitement, rend immédiatement effective une version Applicable dont l'effet était différé.
- Une version `APPLICABLE` ou `OBSOLETE` est immuable et une seule version peut être applicable par pièce.
- Une date d'effet future est refusée avant tout déclassement avec
  `422 VERSION_EFFECTIVE_DATE_FUTURE`. Une version obsolète est refusée avec
  `409 VERSION_NOT_PUBLISHABLE`.
- `POST /api/v1/production/ofs` exige une version applicable et enregistre son snapshot JSON et son
  empreinte SHA-256. Les OF enfants générés récursivement possèdent leur propre snapshot.
- Quand aucune version utilisable n'existe, `VERSION_NOT_APPLICABLE` expose dans `details`
  `piece_technique_id`, `code_piece`, `designation` et les versions candidates (`id`, `indice`,
  `statut`, `date_effet`, `effective_now`). Le frontend peut ainsi guider vers le dossier exact sans
  deviner la pièce à partir d'une recherche.
- Une mise à jour d'OF ne peut pas remplacer sa version, son snapshot, sa date ou son empreinte.

## Fichiers Project Office

- `GET|POST /api/v1/project-office/projects/:id/evidence/files`
- `GET /api/v1/project-office/projects/:projectId/evidence-files/:id/content?disposition=inline|attachment`
- Route de compatibilité authentifiée : `GET /api/v1/project-office/evidence-files/:id/download`

Le formulaire multipart accepte `file`, `category` (`VSM` ou `DOCUMENT`), `version_number`, `status`,
`date_effet`, `visibility`, `title` et `description`. Une VSM exige une version entière positive.
La taille maximale est 25 MiB. Sont contrôlés : extension, MIME annoncé, signature réelle, structure
des archives Bizagi BPM et OOXML, empreinte SHA-256 et doublon dans le projet. Les binaires vivent sous
`CERP_DOCUMENTS_ROOT`; seuls métadonnées et chemin interne sont en base et ce chemin n'est jamais exposé.
La catégorie `VSM|DOCUMENT` est contrainte sur `project_evidence_files` et ne modifie pas l'enum
historique `po_evidence_type`, afin que le patch reste exécutable par le rôle runtime propriétaire
des tables sans élévation permanente.

## Erreurs attendues

| Situation | Réponse |
| --- | --- |
| entrée/code client invalide | 400 |
| conflit d'unicité, version ou doublon | 409 |
| fichier supérieur à 25 MiB | 413 |
| extension, MIME, signature ou archive refusée | 415 |
| projet/fichier inaccessible | politique RBAC du Project Office, sans fuite de chemin |

## Exploitation

Exécuter dans l'ordre le préflight, une sauvegarde vérifiée, le patch et le script `verify`. Inscrire
le fichier et son SHA-256 dans `cerp_schema_migrations`. Le rollback fourni est un garde-fou : il refuse
de retirer les structures dès qu'une valeur de séquence, une version enrichie, un snapshot ou une preuve
les utilise. Les sauvegardes doivent inclure PostgreSQL et le volume documentaire.
