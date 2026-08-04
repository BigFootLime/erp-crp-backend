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

## Scan et quarantaine

Variables de configuration :

- `CERP_UPLOAD_SCAN_MODE=off|monitor|enforce` ; hors tests, une valeur absente
  vaut `enforce` (y compris avec `NODE_ENV=development`) ;
- `CERP_UPLOAD_SCAN_PROVIDER=clamdscan` pour activer l'adaptateur ClamAV ;
- `CERP_UPLOAD_SCANNER_COMMAND` pour remplacer le nom de l'exécutable, sans arguments shell.

Le runtime de tests utilise seul `monitor` par défaut. Hors tests, une valeur de
mode invalide bloque le preflight de démarrage. En mode `enforce`,
`CERP_UPLOAD_SCAN_PROVIDER=clamdscan` est obligatoire au démarrage ; un scanner
ensuite absent ou indisponible renvoie `503 UPLOAD_SCAN_UNAVAILABLE` et aucun
fichier n'est persisté. `monitor` conserve le statut `unavailable` dans l'audit
mais n'affirme jamais qu'un antivirus a validé le contenu. `off` est réservé aux
tests et au rollback d'urgence approuvé.

Déploiement recommandé :

1. installer et superviser `clamdscan` sur les instances, sans envoyer de fichier réel de production pendant la validation ;
2. déployer avec `monitor`, vérifier les audits `security.upload` et la latence sur des fixtures inoffensives ;
3. tester tous les usages de la matrice, y compris scanner arrêté ;
4. passer à `enforce` lorsque le fournisseur est sain sur toutes les instances ;
5. surveiller les `UPLOAD_SCAN_UNAVAILABLE`, `UPLOAD_SIGNATURE_MISMATCH`, volumes et temps de réponse.

## Rollback et nettoyage

Le rollback ne nécessite aucune migration de base. Revenir au commit précédent restaure le code ; si seul le scanner bloque l'exploitation, revenir temporairement à `monitor` après décision sécurité documentée. `off` est un dernier recours limité dans le temps. Les documents historiques restent lisibles dans tous les cas.

Après un arrêt brutal, traiter uniquement le staging :

1. arrêter les instances qui utilisent la racine concernée et relever l'heure du dernier arrêt ;
2. inventorier sans suppression les fichiers de `CERP_TMP_ROOT/upload-quarantine` plus anciens que 24 heures et antérieurs au dernier arrêt ;
3. vérifier qu'aucun processus ne les maintient ouverts et archiver la liste avec tailles et dates ;
4. déplacer la liste explicitement approuvée vers une quarantaine opérateur récupérable ;
5. supprimer cette quarantaine seulement après la durée de rétention opérationnelle convenue.

Ne jamais appliquer cette règle d'âge à `CERP_DOCUMENTS_ROOT`, au coffre GED ou aux preuves Project Office. Pour un orphelin supposé dans un stockage final, produire d'abord un rapprochement lecture seule entre les références de métadonnées et les chemins réels, exclure les documents historiques et les versions retenues, puis déplacer les candidats vers une quarantaine récupérable. Aucune suppression finale ne doit être automatisée à partir du seul nom de fichier.

Une fermeture HTTP n'est jamais une preuve de rollback : elle peut survenir
après un `COMMIT` réussi. Si l'accusé de réception du `COMMIT` est perdu, les
modules Commande, GED et Project Office interrogent une nouvelle connexion.
Un état partiel ou une panne de rapprochement préserve le fichier, renvoie une
erreur d'incertitude et laisse l'opérateur appliquer le rapprochement lecture
seule ci-dessus.

## Vérification minimale

Les fixtures doivent être inoffensives. Vérifier : PDF valide, extension trompeuse, MIME incohérent, zéro octet, dépassement de limite, doublon dans un lot, nom avec traversal, rollback après déplacement final, scanner indisponible en `enforce`, téléchargement historique sans extension et tentative de téléchargement hors racine.
