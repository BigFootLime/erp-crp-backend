# ADR-0081 — PDF sortants autoritatifs et versement GED automatique

Chaque PDF sortant, officiel ou instantané interne de création, est produit
depuis un instantané serveur figé, jamais depuis les données envoyées par le
navigateur. La création de l'entité écrit dans la
même transaction un registre `authoritative_pdf_archives` et une ligne d'outbox.
Le worker rend ensuite le document, vérifie son SHA-256, l'insère dans le coffre
GED adressé par contenu, le lie à l'entité et écrit l'audit GED.

Une création répétée avec la même clé d'idempotence ne crée ni second registre ni
second travail. Les octets, l'empreinte, les liens GED et l'instantané deviennent
immuables une fois archivés. L'absence du coffre ne fait pas perdre la création :
le travail reste `FAILED`, durable et réessayable après correction de l'infrastructure.

Les modules conservent leur autorisation métier avant d'appeler
`queueCreationPdfArchive`; le registre n'ajoute aucune route publique et ne peut
donc pas élargir l'accès à une entité. Chaque producteur serveur explicite est
enregistré dans `AuthoritativePdfProducerRegistry` par le couple
`(entity_type, document_kind)`, afin qu'une même entité puisse porter plusieurs
familles documentaires sans ambiguïté.

Le worker réclame le travail puis exécute le rendu et le versement dans sa propre
transaction GED. En cas d'échec, il termine cette transaction (rollback confirmé)
avant d'ouvrir une transaction fraîche pour appeler `recordAuthoritativePdfItemFailure`.
Chaque réclamation porte un jeton UUID éphémère : une ancienne exécution dont le
lease a été récupéré ne peut ni finaliser ni faire échouer la réclamation plus récente.

La migration de fondation est une création stricte et ponctuelle : elle refuse
une classe GED ou des artefacts #612 préexistants. Son rollback s'appuie sur la
preuve de propriété du registre canonique `cerp_schema_migrations`; un schéma
entièrement non appliqué est un no-op, tandis qu'un artefact sans provenance est
refusé plutôt que supprimé par supposition.

## Contrat HTTP Wave 1

Les collections officielles sont :

- `POST|GET /commandes-fournisseurs/:id/official-documents`
- `POST|GET /devis/:id/official-documents`
- `POST|GET /commandes/:id/acknowledgements`

Chaque collection expose aussi `/:documentId`, `preview`, `download` et
`print-intents`; l'accusé de réception expose en plus `send`. Toutes sont
protégées par l'authentification globale, le contrôle d'accès de module et une
capacité d'export explicite. Les routes ne retournent jamais de chemin physique,
de clé coffre ou d'erreur de rendu brute.

Un `POST` porte `Idempotency-Key` et le corps strict
`{ source_revision, reissue_reason? }`. Il renvoie exactement
`{ state, latest_document, retryable, failure_code }`; l'état de génération UI
est `NOT_GENERATED | PENDING | PROCESSING | READY | FAILED`.
`NOT_GENERATED` signifie strictement qu'aucune tentative durable n'existe;
`PENDING` signifie qu'une ligne outbox durable est bien en attente. Un état
`FAILED` reste la même tentative durable et est repris par le worker, sans
forcer le navigateur à créer une nouvelle édition. `latest_document`, lorsqu'il est
disponible, contient exactement `id`, `kind`, `version` (entier métier),
`state` (`ISSUED | SUPERSEDED | REVOKED`), `safe_filename`,
`byte_sha256`, `byte_length`, `mime_type`, `issued_at`, `source_revision` et
les URL preview/download sûres. Aucun chemin physique, localisateur GED ou
détail d'erreur de rendu ne traverse ce contrat.

Pour les trois familles Wave 1, `source_revision` est le jeton serveur
persisté `updated_at` de l'agrégat. Il est présenté dans le document archivé
pour pouvoir être renvoyé par le navigateur, puis revérifié sous verrou
transactionnel avant toute nouvelle émission. Le SHA-256 de l'instantané est
un champ d'intégrité séparé et ne sert jamais de jeton UI. Une reprise avec la
même clé d'idempotence renvoie toujours l'exemplaire immuable déjà accepté,
même si l'entité a changé entre-temps.

`document_version` est une édition numérique monotone, indépendante de
`render_version` (version interne du modèle PDF). Un même instantané peut être
réémis intentionnellement avec une édition différente; l'unicité est donc
portée par `(entity_type, entity_id, document_kind, document_version)`, tandis
que chaque ligne conserve son instantané, son empreinte et ses octets exacts.

Les accusés de réception sont archivés sous le parent
`commande-client:<commande_id>`, jamais sous l'identifiant transitoire de
l'accusé. Cet identifiant reste figé dans l'instantané pour la traçabilité; la
chronologie et les versions affichées dans la commande sont ainsi continues.

## Automatisation de création et classement GED

Deux politiques documentaires sont volontairement distinctes :

- les documents externes opposables (`CUSTOMER_QUOTE`,
  `SUPPLIER_PURCHASE_ORDER`, accusés de réception) utilisent la classe GED
  `CERP_AUTHORITATIVE_PDF` et le rôle de lien `AUTHORITATIVE_PDF` ;
- les fiches de création internes utilisent la classe
  `CERP_SYSTEM_SNAPSHOT` et le rôle `CREATION_SNAPSHOT`. Elles portent le
  filigrane permanent `INTERNE / BROUILLON` et la mention « non opposable ».

Pour toute nouvelle racine couverte, le registre et l'outbox sont écrits après
la matérialisation de ses dépendances mais avant le `COMMIT` métier. Une erreur
de mise en file annule donc aussi la création. Une erreur ultérieure du worker
GED ne réécrit pas le métier : elle conserve un travail durable et réessayable.

Le périmètre transactionnel couvre les chemins directs et alternatifs suivants :

- client et fournisseur : création directe ;
- commande client : création, conversion d'un devis et duplication ;
- commande fournisseur : création directe, confirmation de propositions,
  conversion de réapprovisionnement et duplication ;
- devis : création directe et nouvelle révision ;
- OF : création manuelle, génération et lancement depuis commande ; seul l'OF
  racine reçoit la fiche, jamais ses enfants ;
- pièce technique : création directe, duplication complète et promotion d'un
  dossier préparatoire ;
- affaire : création directe et tous les parcours de génération métier, sans
  doublon lors d'un replay ;
- article de stock : création directe, promotion préparatoire et les deux
  parcours de création d'article de finition.

Les reprises historiques `OLD` sont explicitement exclues : elles matérialisent
en masse des données antérieures et ne constituent pas une création métier
courante. Aucun backfill implicite n'est exécuté par la migration. Les objets
créés avant cette mise en service peuvent donc répondre `NOT_GENERATED` jusqu'à
une opération de reprise contrôlée distincte.

Les instantanés sont composés par le serveur depuis des colonnes persistées et
une grammaire bornée. Les chemins physiques, octets de pièces jointes, notes
sensibles et clés supplémentaires non déclarées sont rejetés ou omis. Les noms
de fichier sont normalisés et la même clé d'entité `:creation:v1` garantit une
seule fiche initiale, y compris après rejeu idempotent.

## Contrat HTTP des fiches de création

Les sept racines exposées en lecture sont :

- `/clients/:id/creation-snapshot`
- `/fournisseurs/:id/creation-snapshot`
- `/commandes/:id/creation-snapshot`
- `/production/ofs/:id/creation-snapshot`
- `/pieces-techniques/:id/creation-snapshot`
- `/affaires/:id/creation-snapshot`
- `/stock/articles/:id/creation-snapshot`

Pour chacune, `GET` sur la racine retourne la métadonnée ;
`GET /:documentId/preview`, `GET /:documentId/download` et
`POST /:documentId/print-intents` servent exactement l'archive immuable et
journalisent l'acteur. Il n'existe aucun `POST` d'émission ou de réémission pour
une fiche interne. L'existence et le périmètre de la racine sont vérifiés avant
la recherche d'archive, puis les gardes de module existantes restent appliquées.
Les octets sont servis avec `private, no-store`, `nosniff`, une politique
cross-origin restrictive et un `Content-Disposition` sûr ; l'aperçu ajoute un
bac à sable CSP.
