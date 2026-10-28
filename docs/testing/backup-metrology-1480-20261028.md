# Backup Métrologie — correction #1480

Issue : <https://github.com/BigFootLime/erp-crp-backend/issues/1480>.
Branche : `fix/1480-backup-metrology-paths`.

## Défaut vérifié

Le 28 octobre, la sauvegarde complète échoue toutes les trente minutes :
`921 document references are not restorable`. Le dernier point valide a plus
de 22 heures. Les API restent disponibles ; cette alerte de sauvegarde est
conservée comme un incident réel.

Les références immuables de `metrologie_import_source_files.storage_path`
utilisent `uploads/docs/legacy-import/<source-sha>/<blob-sha>.<extension>`.
Depuis #1468, l'application les résout dans le coffre Métrologie canonique,
sans lien symbolique historique. Le résolveur de restauration cherchait encore
leur ancien emplacement.

L'implantation réelle est dans les données applicatives :
`/mnt/data/cerp/data/documents/metrologie/legacy-import`, avec 838 fichiers pour
921 références. Le backup copie déjà ces fichiers par son entrée `data`.
Le coffre GED séparé n'est pas l'emplacement réel de ces sources. Un premier
candidat limité à ce dernier a été refusé par le préflight réel, sans activation.

## Changement

- Traduction limitée à cette table, cette colonne et la forme brute exacte :
  deux SHA en minuscules de 64 caractères, extension xlsx/ods/pdf/zip.
- Recherche des emplacements canoniques de documents dans les racines `data`
  ou `ged` déjà déclarées par le snapshot ; aucun nouvel alias disque.
- Références malformées refusées ; aucun repli sur l'ancien alias quand le
  fichier canonique manque. Taille et SHA restent obligatoirement vérifiés
  lorsqu'ils sont présents dans la référence.
- Les autres tables, clés GED et chemins absolus gardent leur comportement.
  Aucun document, historique, référence immuable, schéma ou politique d'alerte
  n'est modifié.

## Preuves avant activation

- Reproduction isolée avant correction : 14 tests en échec sur 21, dont les
  quatre formats légitimes non retrouvés. La série a ensuite été complétée.
- Résultat final : 36 tests réussis, dont 24 cas du résolveur de restauration,
  4 cas de documents intégrés en base et 8 cas du résolveur API existant.
- Contrôle TypeScript global `--noEmit` réussi, code de sortie 0.
- Source déployée d'origine :
  `7bdac6dc4cee0c79d78f5916511e41eee42865f1aa539e91487cc582dcde4ef8`.
  Son contenu est identique à la base Git après normalisation CRLF/LF.
- Correctif testé et installé à part :
  `30955d1cd6b173466e56c70cff9c5d83c0ac9608df8b9c47dc7214fb9bc6a0c6`.
- À 12:04 CET, lecture des références réelles : ancien outil 921 échecs ;
  candidat 921 vérifiées, 921 SHA et tailles conformes, 0 échec ; 838 chemins
  physiques distincts. Fichier des références conservé uniquement sur l'hôte,
  sans inclusion de données de production dans Git.

## Activation et validation d'exploitation

À 12:07 CET, activation du seul outil de sauvegarde par un drop-in dédié :
`zz-backup-metrology-1480.conf`. Le service canonique
`cerp-backup-full.service` a été demandé une fois. Ses autres paramètres,
sa politique de rétention, le programme de supervision et les services API
restent inchangés. Le fichier d'origine n'a pas été écrasé.

Preuves privées :
`/var/lib/cerp-alerting-1771/backup-1480-20261028T110412Z/`.
Retour arrière : retirer uniquement ce drop-in et relire systemd ; l'outil
d'origine est toujours présent. Ce retour arrière réintroduit le défaut des
921 références et ne doit pas être confondu avec une correction.

La nouvelle sauvegarde, sa restauration isolée et le rétablissement de la
supervision sont en cours de vérification. Aucun résultat final n'est encore
annoncé dans cette version du relevé.

## Autre alerte de ressources traitée

L'ancienne UI 2.0.28 était saine, mais sans les limites attendues par son
profil. Après préflight mémoire/processus, limites restaurées à 11:58 CET :
512 Mio, CPU 1, PID 256, sans swap supplémentaire. Conteneur exact conservé,
sain, heure de démarrage et compteur de redémarrage inchangés. Le premier
essai Docker avait été refusé faute d'un paramètre memory-swap explicite ;
les reçus des deux essais sont conservés sous
`/var/lib/cerp-alerting-1771/ui-limits-20261028/`.
