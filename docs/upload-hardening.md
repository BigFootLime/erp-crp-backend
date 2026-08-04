# Politique de sécurité des uploads CERP

Statut : mise en œuvre de `SEC-CERP-0003` / `GPT56-CERP-0011`.

## Contrat commun

Tout nouvel upload HTTP passe par `src/shared/uploads/secure-upload.ts` et une politique déclarée dans `upload-policy.ts`. Le middleware :

- impose un plafond de taille, de nombre de fichiers et de champs avant le traitement métier ;
- refuse les noms vides, ambigus, trop longs, les contrôles Unicode et toute composante de chemin ;
- vérifie l'extension, le MIME déclaré et les octets significatifs ;
- refuse les fichiers vides, les exécutables renommés et les doublons de contenu dans un même envoi ;
- calcule une empreinte SHA-256 et publie le résultat du scan dans `file.uploadSecurity` ;
- conserve les fichiers disque dans `CERP_TMP_ROOT/upload-quarantine/<usage>` jusqu'à validation ;
- crée cette quarantaine en `0700` et chaque `.part` atomiquement en `0600` ;
  un abort pendant la réception ferme le descripteur et déclenche un nettoyage
  audité avant tout traitement métier ;
- supprime après la réponse uniquement le staging encore sous sa responsabilité ;
- ne supprime une destination finale qu'après un `ROLLBACK` pré-`COMMIT`
  confirmé, ou après un rapprochement sur une nouvelle connexion prouvant que
  le `COMMIT` tenté n'a pas été appliqué ;
- journalise usage, acteur, requête, volume, résultat et statut du scan, sans nom, chemin ni contenu du fichier.

Les documents déjà stockés ne sont pas revalidés par cette politique. Le
téléchargement valide le chemin puis ouvre le fichier sans suivre le dernier
lien symbolique, compare `dev`/`ino`/taille avec la validation et sert exactement
ce descripteur. Les réponses ajoutent `nosniff`, `Cache-Control: private,
no-store`, une politique cross-origin de même origine et un
`Content-Disposition` neutralisé. La GED stage sur disque et traite par flux son
plafond de 512 Mo ; aucun Buffer de cette taille n'est créé.

## Matrice par usage

| Usage central | Modules | Limite par fichier | Nombre | Formats |
|---|---|---:|---:|---|
| `business-document` | commande client, devis, fournisseurs, livraisons, planning, stock | 25 Mo | 10 | PDF, images, texte/CSV, Word, Excel, ODF |
| `technical-document` | pièces techniques, dossiers d'opération | 25 Mo | 10 | formats métier + TIFF, archives, STEP/STL/DXF/DWG/IGES/3MF et formats CAO/CN historiques |
| `machine-document` | parc machine | 50 Mo | 1 | formats techniques |
| `quality-document` | qualité, réceptions, métrologie v1/v2 | 25 Mo | 10 | formats métier + TIFF |
| `image` | images d'entités et de production | 10 Mo | 3 | PNG, JPEG, WebP, GIF |
| `tool-media` | outillage | 25 Mo | 3 | images ou PDF |
| `import-tabular` | assistant d'import | 25 Mo | 1 | CSV ou XLSX |
| `ged-deferred` | GED | transport 512 Mo | 1 | classe GED validée ensuite ; contrôles communs et anti-exécutable immédiats |
| `project-evidence-deferred` | preuve Project Office | 25 Mo | 1 | type de preuve validé ensuite ; contrôles communs immédiats |
| `project-asset-image` | capture Project Office | 5 Mo | 1 | PNG ou JPEG |

Les plafonds GED et Project Office sont des plafonds de transport. Les règles de classe ou de preuve existantes restent plus restrictives et continuent de s'appliquer avant persistance.

### Archives structurelles

Les formats ZIP, 3MF, DOCX, XLSX, PPTX, ODT et ODS ne sont jamais acceptés
sur la seule présence du préfixe `PK` ni sur un marqueur trouvé dans les 64 Kio
de tête ou de fin. Le validateur lit paresseusement le répertoire central et
chaque en-tête local, interdit ZIP64, le chiffrement, les méthodes autres que
`store`/`deflate`, les liens et types spéciaux, les chemins absolus ou avec
`..`, les collisions de noms et les plages qui se chevauchent. Il décompresse
en flux sans extraction, recompte la taille et vérifie le CRC-32 de chaque
entrée avant le scan ClamAV.

Les bornes applicatives sont explicites : archive 64 Mio au plus (les politiques
HTTP restent à 25/50 Mio), 2 048 entrées, répertoire central 4 Mio, commentaire
1 Kio, nom 512 octets et profondeur 32 ; une entrée est limitée à 64 Mio
compressés et 128 Mio décompressés, l'ensemble à 64/256 Mio, avec un ratio de
compression maximal de 200. Les XML de package inspectés sont limités à 1 Mio,
4 096 éléments et 32 attributs par élément ; `DOCTYPE` et les entités déclarées
sont refusés.

Les pièces principales XML sont aussi parsées en flux et doivent être bien
formées, avec la racine et l'espace de noms attendus ; elles sont limitées à
250 000 éléments et 64 attributs par élément.

DOCX/XLSX/PPTX exigent `[Content_Types].xml`, `_rels/.rels` et leur partie
principale avec le type MIME OOXML exact. 3MF exige les mêmes manifests et
`3D/3dmodel.model` avec le type 3MF exact. ODT/ODS exigent `mimetype` comme
première entrée non compressée sans extra field, `META-INF/manifest.xml`,
`content.xml` et le media type ODF exact. Une archive tronquée, ambiguë ou dont
un CRC ne correspond pas est rejetée `415 UPLOAD_SIGNATURE_MISMATCH`.

## Scan et quarantaine

Variables de configuration :

- `CERP_UPLOAD_SCAN_MODE=off|monitor|enforce` ; `off` et `monitor` sont réservés
  au processus `NODE_ENV=test`. Hors tests, seule la valeur `enforce` est admise
  (une valeur absente vaut `enforce`, y compris avec `NODE_ENV=development`) ;
- `CERP_UPLOAD_SCAN_PROVIDER=clamdscan` pour activer l'adaptateur ClamAV ;
- `CERP_UPLOAD_SCANNER_COMMAND` pour remplacer le nom de l'exécutable, sans arguments shell.
- `CERP_UPLOAD_SCANNER_TIMEOUT_MS` borne chaque scan (120 s dans l'image,
  valeurs acceptées de 1 s à 300 s).

Le runtime de tests utilise seul `monitor` par défaut. Hors tests, une valeur de
mode invalide, `off` ou `monitor` bloque le preflight de démarrage. En mode `enforce`,
`CERP_UPLOAD_SCAN_PROVIDER=clamdscan` est obligatoire au démarrage ; un scanner
ensuite absent ou indisponible renvoie `503 UPLOAD_SCAN_UNAVAILABLE` et aucun
fichier n'est persisté. `monitor` conserve le statut `unavailable` dans l'audit
mais n'affirme jamais qu'un antivirus a validé le contenu. `off` est réservé aux
tests isolés et n'est pas un mode de rollback de production.

L'image Docker/Coolify est autonome. Builder et runtime utilisent exactement
Node LTS `24.18.0` sur Alpine `3.24`, via l'index OCI multi-architecture épinglé
`sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd`.
Les dépôts sont explicitement les branches stables `v3.24/main` et
`v3.24/community` ; aucun paquet `edge` n'est utilisé. Les paquets directs
`curl 8.21.0-r0`, `tini 0.19.0-r3`, `su-exec 0.3-r0`, ainsi que `clamav`,
`clamav-daemon`, `clamav-clamdscan` et `freshclam` en `1.4.5-r0`, sont épinglés.
L'image installe `clamd` et `clamdscan` mais n'embarque aucune base mutable ou
datée : le build froid ne dépend donc pas du CDN de signatures. `freshclam`
actualise le volume `/var/lib/clamav` à chaque démarrage, puis reste en tâche
supervisée (12 vérifications par jour). L'application ne démarre qu'après le
ping du daemon ayant chargé ses signatures. Le healthcheck vérifie à la fois ce
ping et l'HTTP applicatif. Le scan utilise `clamdscan --fdpass` : le daemon ne
dépend donc pas des permissions privées (`0600`) des fichiers de staging, et
aucun nom ou argument utilisateur n'est interprété par un shell.
Le premier démarrage d'un volume vide exige un accès sortant vers le CDN ClamAV
et échoue fermé si la mise à jour est impossible. Aux démarrages suivants, une
panne réseau peut utiliser la base persistée seulement si `clamd` l'accepte
encore sous `FailIfCvdOlderThan 7`.
`AlertExceedsMax yes`, avec `HeuristicAlerts yes`, transforme tout plafond de
taille, décompression, nombre de fichiers ou récursion en détection
`Heuristics.Limits.Exceeded` (code scanner 1) : une portion non inspectée ne
peut jamais être déclarée propre. `MaxRecursion 16` et `MaxFiles 10000` bornent
les conteneurs, tandis que les plafonds `550M` couvrent le transport GED de
512 Mio ; une archive qui dépasse ces bornes est volontairement rejetée.

### Propriété et permissions des stockages

Deux profils sont intentionnels ; aucun préflight n'ajoute un bit d'écriture
qui n'existait pas déjà.

| Cible réelle | Avant transition | Postcondition automatique | Contenu parcouru |
|---|---|---|---|
| HYPERBOX `prod`, `test`, `documents`, `generated`, `exports`, `tmp` | `cerp:cerp_write 2770` | `cerp:cerp_write 3770` | oui ; répertoires déjà group-write gagnent seulement sticky, fichiers applicatifs `0660` deviennent `0600` |
| HYPERBOX coffre GED | `cerp:cerp_write 2750` | `2750` inchangé ; `vault`/`staging` privés `0700`, blobs `0600` | oui, racine GED exacte |
| HYPERBOX `inbound` | racine `cerp:cerp_write 2770` | racine exacte `3770` | non ; `inbound/integrations` et ses entrants de propriétaires tiers sont préservés |
| HYPERBOX `/srv/cerp/data/postgres` | environ 38 répertoires et 17 150 fichiers `postgres:postgres`, fichiers `0600` | strictement inchangé | jamais : sibling hors allowlist |
| VPS/Coolify `/app/data` monté | legacy `uid 1000`, racine et 14 répertoires `0755`, aucun fichier observé | `node:node 0750` à la racine, descendants `0700` | oui, uniquement ce mount |
| VPS/Coolify `/app/uploads` bind peuplé | legacy `uid 9999`, racine et descendants `2755`, environ 30 fichiers `0755`, `nlink=1` | `node:node 0700`, descendants `0700`, fichiers `0600` | oui, uniquement ce mount |

Sur HYPERBOX, `/srv/cerp` résout vers `/mnt/data/cerp`. Le parent
`/mnt/data` est réellement `keenan:keenan 0775` et constitue une frontière
administrative explicite, non inscriptible par `cerp_write` ni par others :
configurer `CERP_UPLOAD_ADMIN_TRUST_ROOTS=/mnt/data`. Une autre racine
administrative se sépare par `:` sous Linux. Un ancêtre possédé par un UID
tiers qui n'est ni root, ni le service, ni exactement dans cette allowlist fait
échouer le démarrage. Le share Samba `CERP_DOCUMENTS` pointe vers
`/srv/cerp/shares/documents`, distinct de `CERP_DOCUMENTS_ROOT`; il reste hors
du parcours et n'est pas muté.

Le préflight applicatif s'exécute avant l'import des routes. Il sécurise la
seule entrée `CERP_STORAGE_ROOT`, mais ne descend jamais aveuglément dans ses
siblings. Il inventorie globalement les racines exactes `documents`,
`generated`, `exports`, `tmp`, `images` et GED, sans suivre de lien, avant de
modifier leurs fichiers. Cela accepte un hardlink de crash encore présent entre
`tmp` et `documents`, mais refuse un hardlink dont un lien manque à l'inventaire
(par exemple vers `postgres`) avant de toucher cet inode. Le parcours est borné
par `CERP_UPLOAD_PREFLIGHT_MAX_NODES` (200 000 par défaut, maximum 1 000 000).
Il ne fait aucun `chown` : un owner/groupe inattendu dans une racine
applicative échoue fermé en `503 UPLOAD_STAGING_PERMISSION_FAILED`.

Le sticky bit protège chaque entrée possédée par `cerp` dans un parent
group-write : un autre membre de `cerp_write` peut créer sa propre entrée mais
ne peut renommer ou supprimer ni la racine attendue, ni son enfant possédé par
`cerp`. Le contrôle marche de haut en bas avant toute création dynamique. Un
parent `2750`, `0750` ou `0700` conserve sa classe sans devenir group-write ; un
enfant partagé nouvellement créé hérite de cette classe. Les auxiliaires
`upload-quarantine/<usage>`, `.secure-buffer-staging`, `.secure-delete` et les
staging/vault GED sont forcés en `0700`, et leurs fichiers en `0600`.

Chaque composant est contrôlé par `lstat`/`realpath`, puis ouvert sous Linux
avec `O_DIRECTORY|O_NOFOLLOW`; `dev`/`ino`, UID/GID et mode sont revérifiés via
le descripteur. Un lien symbolique ou junction, une substitution de chemin ou un
répertoire précréé par un autre membre du groupe produit un 503. Les fichiers
entrants sont eux aussi ouverts avec `O_NOFOLLOW`, comparés à l'identité
capturée lors du `open(..., "wx", 0600)`, puis nettoyés par renommage/inode ;
aucun `unlink(...).catch(() => undefined)` n'est un chemin de succès.

Dans Docker, les modes de l'image sont masqués par les volumes existants.
L'entrypoint reste root uniquement le temps d'inventorier `/app/data` et
`/app/uploads`, refuse symlinks, inodes spéciaux, owner mixte inattendu et
hardlink sortant, puis migre par descripteur et valide les postconditions. Il
n'utilise ni `chown -R` ni `chmod -R`, conserve octets, noms, inodes et mtime,
et ne touche aucun chemin hors de ces deux mounts. Ensuite seulement il lance
l'application avec `su-exec node`; l'application ne tourne jamais en root.

### Déploiement Ubuntu/systemd (HYPERBOX2)

Cette voie est distincte de l'image Docker. Elle cible Zorin OS 18 basé sur
Ubuntu 24.04 Noble et le service `cerp-api`. Au 2026-08-04, le paquet amd64
Noble security validé est `1.5.3+dfsg-0ubuntu0.24.04.1`. Il ne doit pas être
épinglé : installer les mises à jour de sécurité signées de la distribution et
rejouer les contrôles ci-dessous après une évolution majeure. La
[fiche du paquet Ubuntu](https://packages.ubuntu.com/noble-updates/clamav-daemon)
et la [page de manuel Noble de `clamdscan`](https://manpages.ubuntu.com/manpages/noble/man1/clamdscan.1.html)
confirment les options utilisées par l'application : `--fdpass`, `--stream`,
`--ping`, `--no-summary` et `--config-file`, ainsi que les codes de sortie 0
(propre), 1 (infecté) et 2 (erreur). Le séparateur `--` garde le chemin hors de
l'analyse des options. Ces opérations appartiennent au déploiement opérateur ;
elles ne sont pas exécutées automatiquement par l'application.

1. Relever la version candidate, puis installer `clamav`, `clamav-daemon`,
   `clamav-freshclam` et `clamdscan` depuis les dépôts Noble activés. Vérifier
   ensuite `/usr/bin/clamdscan --version` et conserver la sortie dans la preuve
   de déploiement. Ne pas substituer `clamscan` : l'adaptateur appelle le client
   du daemon `clamdscan`.

   ```bash
   sudo apt-get update
   apt-cache policy clamav clamav-daemon clamav-freshclam clamdscan
   sudo apt-get install --yes clamav clamav-daemon clamav-freshclam clamdscan
   /usr/bin/clamdscan --version
   ```

2. Configurer `/etc/clamav/clamd.conf` avec un socket Unix local
   `/run/clamav/clamd.ctl`, `LocalSocketGroup clamav`, `LocalSocketMode 660` et
   `User clamav`. Conserver au minimum les bornes de l'image : `MaxThreads 2`,
   `MaxQueue 8`, `MaxFileSize 550M`, `MaxScanSize 550M`,
   `StreamMaxLength 550M`, `PCREMaxFileSize 550M` et
   `FailIfCvdOlderThan 7`. Activer explicitement `HeuristicAlerts yes` et
   `AlertExceedsMax yes`, avec `MaxRecursion 16` et `MaxFiles 10000`, pour que
   toute analyse tronquée par une borne soit un rejet. Vérifier les valeurs effectives après toute
   régénération Debian/Ubuntu du fichier.
3. Conserver exactement l'identité primaire existante de `cerp-api` :
   `User=cerp`, `Group=cerp_write` et `UMask=0007`. Ajouter seulement le groupe
   supplémentaire `clamav` avec `SupplementaryGroups=clamav` dans l'override
   systemd ; ne jamais remplacer le groupe primaire du service. Vérifier avec
   `id cerp` et, après
   redémarrage du service, dans `/proc/<pid>/status`. Ne pas rendre le socket
   world-writable. Le processus `cerp` ouvre son staging `0600` et
   `clamdscan --fdpass` transmet ce descripteur au daemon `clamav` ; le daemon
   n'a donc besoin ni de devenir `cerp`, ni de lire le chemin privé directement.
   L'override de l'unité doit aussi déclarer
   `After=clamav-daemon.service` et `Wants=clamav-daemon.service`; cela ordonne
   le démarrage mais ne remplace pas le ping de disponibilité.
4. Amorcer ou actualiser les signatures avec `freshclam`, sans lancer une
   seconde instance contre le verrou de la tâche systemd. Si une mise à jour
   manuelle initiale est nécessaire, arrêter temporairement
   `clamav-freshclam.service`, exécuter `/usr/bin/freshclam`, puis réactiver le
   service. Activer et démarrer `clamav-freshclam.service`, puis
   `clamav-daemon.service`; le daemon ne doit être déclaré prêt qu'après le
   chargement des signatures. `systemctl is-active` doit répondre `active` pour
   les deux unités et `sudo -u cerp /usr/bin/clamdscan --ping=5:1` doit réussir.
5. Renseigner les cinq valeurs suivantes dans le fichier réellement chargé
   par chaque API systemd, via `dotenv` dans son répertoire de travail ou via
   `EnvironmentFile`. Sur HYPERBOX2, la production charge
   `/srv/cerp/apps/api/.env` et le canary de test charge
   `/srv/cerp/apps/api/.env.test`; conserver les deux fichiers en mode `0640`
   et propriété `cerp:cerp_write`. Après création
   de l'override, exécuter `systemctl daemon-reload`, puis redémarrer `cerp-api`
   seulement après le ping réussi :

   ```dotenv
   CERP_UPLOAD_SCAN_MODE=enforce
   CERP_UPLOAD_SCAN_PROVIDER=clamdscan
   CERP_UPLOAD_SCANNER_COMMAND=/usr/bin/clamdscan
   CERP_UPLOAD_SCANNER_TIMEOUT_MS=120000
   CERP_UPLOAD_ADMIN_TRUST_ROOTS=/mnt/data
   ```

   Appliquer exactement ces valeurs aux parcours `cerp_test` et `cerp_prod`, ou
   aux deux unités si elles sont séparées. Le choix de la base ne doit jamais
   basculer le scanner sur `monitor` ou `off`. Le défaut `monitor` de Vitest est
   réservé au harnais de tests unitaires, pas à une API connectée à `cerp_test`.
   Confirmer dans le journal de démarrage
   `mode=enforce provider=clamdscan ready=true`; une API démarrée avec
   `ready=false` reste joignable mais bloque volontairement tous les uploads.
   Arrêter les deux API avant la première transition de permissions, puis les
   redémarrer une par une : leur préflight idempotent applique la matrice
   `2770→3770`/`0660→0600` uniquement aux racines applicatives allowlistées.
   Archiver son compteur de racines/nœuds ; ne lancer aucun `chmod -R` ou
   `chown -R` opérateur en parallèle.

Le smoke systemd se fait d'abord sur `cerp_test`, dans une fenêtre contrôlée :

- sous `cerp`, créer une fixture texte inoffensive, propriété `cerp:cerp_write` et
  mode `0600`, puis lancer
  `/usr/bin/clamdscan --fdpass --no-summary -- <chemin>` ; attendre le code 0 ;
- répéter avec une fixture EICAR dédiée, elle aussi en `0600`, attendre le code
  1 et `FOUND`, puis la supprimer strictement ; un code 2 invalide le smoke ;
- par l'API reliée à `cerp_test`, vérifier qu'un fichier propre autorisé est
  accepté, qu'EICAR produit `422 UPLOAD_SCAN_REJECTED`, et qu'aucun staging ni
  durable n'est laissé après le rejet ;
- pendant une injection de panne approuvée, arrêter brièvement
  `clamav-daemon.service`, vérifier qu'un upload propre retourne
  `503 UPLOAD_SCAN_UNAVAILABLE` sans persistance, redémarrer immédiatement le
  daemon, attendre le ping, puis refaire le smoke propre ; ne jamais réaliser
  cette injection sur `cerp_prod` hors fenêtre de maintenance ;
- après validation de `cerp_test`, vérifier sur `cerp_prod` le ping sous `cerp`
  et une fixture métier inoffensive seulement. Archiver versions, codes de
  sortie, états systemd et identifiants de requête, jamais les chemins ou le
  contenu des documents utilisateurs.

Pour un rollback systemd, restaurer le release API précédent tout en laissant
les paquets, signatures, services ClamAV et variables `enforce` en place : les
anciennes versions qui ignorent ces variables ne sont pas gênées. Si seule la
configuration ClamAV doit être annulée, restaurer sa sauvegarde opérateur,
redémarrer `clamav-freshclam` puis `clamav-daemon`, attendre le ping et seulement
ensuite redémarrer `cerp-api`. Ne jamais utiliser `monitor` ou `off` pour faire
passer un déploiement en échec. Tant que le daemon n'est pas sain, conserver
l'API en état dégradé avec uploads bloqués (ou l'arrêter), ne pas supprimer
`/var/lib/clamav`, et ne retirer l'accès du compte `cerp` au socket qu'après le
retour complet à un release qui n'en dépend plus.

Le conteneur doit disposer d'au moins 2 Gio de RAM, 2 vCPU et 1 Gio de disque
pour `/var/lib/clamav`; mesurer puis augmenter ces réserves avec la charge réelle
et les fichiers GED proches de 512 Mio. `MaxThreads=2` et `MaxQueue=8` bornent
la concurrence dans une instance. Le volume de signatures est déclaré dans
l'image et doit être conservé entre les remplacements de conteneur. Une
reconstruction ne télécharge aucune base au build ; un volume vide est amorcé
au démarrage. Une panne réseau peut utiliser la base persistée, mais `clamd`
refuse de charger une base vieille de plus de 7 jours. Une panne du daemon rend le
conteneur unhealthy et chaque upload encore en cours échoue fermé.

Après déploiement, vérifier une fixture inoffensive par le chemin d'upload, une
fixture EICAR dédiée au smoke de sécurité, puis scanner arrêté. Surveiller les
`UPLOAD_SCAN_UNAVAILABLE`, `UPLOAD_SCAN_REJECTED`, volumes et temps de réponse.
L'image fournit le smoke non destructif utilisé en CI/revue :
`docker run --rm -e CERP_SCANNER_SMOKE=1 <image>`. Il exécute, sous l'utilisateur
`node`, un scan propre, un rejet EICAR et un rejet
`Heuristics.Limits.Exceeded` obtenu par une petite archive imbriquée au-delà de
`MaxRecursion`, tous sur des fichiers `0600`, puis les supprime strictement.

Coolify doit utiliser une sonde effective combinant le ping `clamd` et l'HTTP
applicatif (puis la readiness realtime quand elle est disponible). Une sonde
HTTP `/` configurée par la plateforme peut masquer le `HEALTHCHECK` de l'image :
le gate de déploiement doit donc vérifier la commande réellement appliquée avec
`docker inspect`, tuer temporairement le scanner sur le canary approuvé et
confirmer l'état unhealthy avant promotion. Les variables explicites
`CERP_UPLOAD_SCAN_MODE=enforce`, `CERP_UPLOAD_SCAN_PROVIDER=clamdscan` et
`CERP_UPLOAD_SCANNER_COMMAND=clamdscan` restent enregistrées dans Coolify même
si l'image fournit les mêmes valeurs par défaut.

Le smoke permissions Linux est
`docker run --rm -e CERP_STORAGE_SECURITY_SMOKE=1 <image>`. Dans un conteneur
éphémère il crée un second compte du même groupe, prouve les refus de rename,
delete, mutation `0600`, symlink et owner tiers, les non-escalations `2750` et
`0755`, la préservation d'un sibling PostgreSQL/inbound exclu, et les deux cas
de hardlink. Le cas de rejet place son lien externe dans la dernière racine
inventoriée et confirme que modes, owners, mtime et contenus de toutes les
racines antérieures restent inchangés : la découverte complète ne mute rien.
Pour auditer un mount Coolify réel sans lancer ClamAV ni l'API, utiliser
`CERP_STORAGE_PREFLIGHT_ONLY=1` dans une fenêtre où aucune autre instance
n'écrit, puis relever les `stat` et empreintes sentinelles avant/après.

Avant le premier canary Coolify, arrêter l'unique writer et sauvegarder les
deux mounts, surtout le bind **peuplé** `/app/uploads` : liste ordonnée des noms,
empreintes, tailles, inodes, nlink, mtime, UID/GID et modes. Tester d'abord sur
une copie complète des volumes reproduisant les 14 répertoires `/app/data` et
les fichiers réels `/app/uploads`, jamais sur un volume vide. Le smoke attendu
change seulement owner/modes (`1000:1000 0755` ou `9999:9999 2755/0755` vers
`node:node 0750/0700/0600`) et prouve que noms, inodes, mtime et empreintes sont
identiques. Valider aussi un redémarrage et un rollback sur cette copie. Pendant
le canary réel, observer le pic mémoire de `clamd`, `freshclam` et Node en plus
du healthcheck ; le dimensionnement constaté est suffisant mais ne remplace pas
cette mesure sous charge.

## Rollback et nettoyage

Le rollback ne nécessite aucune migration de base. Revenir à l'image précédente
restaure le code ; le volume de signatures reste séparé, le démarrage tente
toujours une mise à jour et refuse une base trop ancienne. La migration de propriété des
mounts est toutefois persistante : avant production, le canary sur copie doit
prouver que l'image précédente lit la postcondition `node:node`, ou le plan de
rollback doit restaurer la sauvegarde complète des deux mounts prise writer
arrêté. Ne jamais recréer un `/app/uploads` vide ni appliquer un `chown -R` sur
le bind peuplé comme raccourci de rollback. En production, conserver `enforce` pendant un
rollback : `monitor` et `off` ne sont autorisés que dans un
environnement de test isolé. Les documents historiques restent lisibles dans
tous les cas.

Après un arrêt brutal, traiter uniquement le staging :

1. arrêter les instances qui utilisent la racine concernée et relever l'heure du dernier arrêt ;
2. inventorier sans suppression les fichiers de `CERP_TMP_ROOT/upload-quarantine` plus anciens que 24 heures et antérieurs au dernier arrêt ;
3. vérifier qu'aucun processus ne les maintient ouverts et archiver la liste avec tailles et dates ;
4. déplacer la liste explicitement approuvée vers une quarantaine opérateur récupérable ;
5. supprimer cette quarantaine seulement après la durée de rétention opérationnelle convenue.

Ne jamais appliquer cette règle d'âge à `CERP_DOCUMENTS_ROOT`, au coffre GED ou aux preuves Project Office. Pour un orphelin supposé dans un stockage final, produire d'abord un rapprochement lecture seule entre les références de métadonnées et les chemins réels, exclure les documents historiques et les versions retenues, puis déplacer les candidats vers une quarantaine récupérable. Aucune suppression finale ne doit être automatisée à partir du seul nom de fichier.

Les nettoyages de destinations possédées utilisent un renommage atomique vers
un nom aléatoire dans le répertoire frère privé `.secure-delete` (`0700`), puis
comparent le couple exact `dev`/`ino`. Seul l'inode attendu est supprimé. Un
inode différent est restauré par lien exclusif si le chemin est encore libre ;
si un nouvel inode occupe déjà ce chemin, l'inode déplacé reste dans
`.secure-delete`. La tombstone protégée est conservée même si le lien de
restauration réussit, afin qu'un remplacement ultérieur du chemin ne puisse pas
supprimer le dernier lien de l'inode à rapprocher. Dans tous les cas, l'inode
différent n'est jamais supprimé,
le mismatch déclenche une alerte structurée et l'opération échoue explicitement
avec `503 UPLOAD_CLEANUP_FAILED` (ou le code d'incertitude 503 du module qui
l'encapsule). Il n'existe aucun succès silencieux de type « replaced ».

Une tombstone résiduelle est un incident à rapprocher, pas un déchet d'âge :

1. préserver les écritures courantes, puis inventorier `.secure-delete` en
   lecture seule avec `find ... -type f -print` et `stat` ; archiver dans un
   emplacement restreint le chemin, `dev`/`ino`, propriétaire, mode, taille et
   date, sans lire ni exposer le contenu ;
2. rapprocher chaque entrée avec le chemin durable actuel, les clés de stockage,
   SHA-256 et références de métadonnées sur une connexion de base en lecture
   seule, ainsi qu'avec la référence de requête de l'alerte ;
3. si la propriété reste ambiguë ou qu'une référence existe, conserver les deux
   inodes et escalader ; ne jamais déduire la propriété du nom ou de l'âge ;
4. après validation explicite d'un opérateur, déplacer l'unique chemin approuvé
   vers une quarantaine récupérable en préservant propriétaire et mode, puis
   refaire le rapprochement ;
5. ne supprimer qu'après la rétention convenue, une seconde approbation et une
   nouvelle vérification exacte de l'inode, un fichier à la fois.

Ne jamais utiliser `find -delete`, `find -exec rm`, un wildcard `rm` ou une
purge automatique par âge dans `.secure-delete`.

Une fermeture HTTP n'est jamais une preuve de rollback : elle peut survenir
après un `COMMIT` réussi. Si l'accusé de réception du `COMMIT` est perdu, les
modules Commande, GED et Project Office interrogent une nouvelle connexion.
Un état partiel ou une panne de rapprochement préserve le fichier, renvoie une
erreur d'incertitude et laisse l'opérateur appliquer le rapprochement lecture
seule ci-dessus.

Dans la GED, chaque promotion, writer de métadonnées (y compris l'archivage des
PDF d'OF) et compensation d'un même SHA-256 prend le même verrou consultatif de
transaction PostgreSQL. La promotion n'a lieu qu'après acquisition du verrou,
qui reste tenu jusqu'au `COMMIT` ou `ROLLBACK`. Une compensation reprend ensuite
ce verrou sur une connexion fraîche et ne supprime que sa propre destination si
aucun blob ni aucune version validée ne la référence. Ainsi, un second writer
qui gagne la fenêtre entre le rollback et le cleanup est soit observé après son
commit, soit recrée le blob après la suppression ; un blob préexistant seulement
dédupliqué n'est jamais supprimé par le nouvel upload.

Les 503 opérationnelles liées aux dépôts utilisent une allowlist exacte de codes
et des messages publics constants. Une incertitude de commit demande de ne pas
relancer aveuglément mais d'actualiser et vérifier l'état ; une incertitude de
rollback/nettoyage demande une intervention contrôlée ; une indisponibilité du
scanner ou du staging autorise une nouvelle tentative ultérieure. Le frontend
ajoute la référence de requête aux cas nécessitant un rapprochement.

## Vérification minimale

Les fixtures doivent être inoffensives. Vérifier : PDF valide, extension trompeuse, MIME incohérent, zéro octet, dépassement de limite, doublon dans un lot, nom avec traversal, rollback après déplacement final, les deux ordres du verrou entre cleanup et second writer du même SHA, double rollback, ACK de COMMIT perdu, writer OF concurrent, blob dédupliqué non possédé, scanner indisponible en `enforce`, téléchargement historique sans extension et tentative de téléchargement hors racine.
