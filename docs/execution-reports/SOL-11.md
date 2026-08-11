# Rapport d'exécution SOL-11 — backend

Date : 2026-08-11. Branche : `fix/sol-11-document-antivirus-quarantine`.

## Diagnostic et cause racine

Le transport d'upload savait déjà analyser un fichier de manière synchrone avec
ClamAV et le runtime hors test imposait le mode bloquant. En revanche, la GED ne
conservait pas le verdict avec la version publiée et ne disposait pas d'un objet
de quarantaine durable et administrable. Un verdict infecté supprimait le
staging : il n'existait donc ni reprise, ni suppression/libération auditée, ni
preuve durable reliant la version, le moteur et les signatures.

Le smoke Docker a également reproduit une cause réelle d'échec de déploiement
depuis Windows : les scripts et configurations copiés dans l'image gardaient
leurs fins de ligne CRLF. Linux refusait l'entrypoint, puis `freshclam` refusait
`ScriptedUpdates yes\r`. L'image normalise désormais ces fichiers avant de leur
donner leurs permissions d'exécution ; `.gitattributes` fixe aussi leur format
pour les prochains checkouts.

## Choix d'architecture

- validation transport (taille, extension, signature, empreinte) avant toute
  persistance, puis copie immédiate en coffre privé `quarantine/` ;
- session SQL `pending` créée uniquement après la copie durable ; aucune version
  GED ne peut référencer une session dont le verdict n'est pas `clean` ;
- états persistés `pending`, `clean`, `infected`, `scan_failed` et états de
  quarantaine `pending`, `quarantined`, `released`, `deleted` ;
- scan depuis le fichier durable, version ClamAV, durée, compteur de tentatives,
  date, acteur et événements d'audit sans contenu documentaire ;
- verdict sain : copie de libération vérifiée par SHA-256, promotion sous verrou
  de hash et transaction SQL, suppression de la quarantaine seulement après
  commit confirmé ;
- verdict infecté ou scanner indisponible : publication impossible, fichier
  privé conservé, réponse explicite `422 GED_SCAN_INFECTED` ou
  `503 GED_SCAN_FAILED` ;
- API de quarantaine réservée à la capacité GED `admin` : liste, réanalyse,
  libération après nouveau verdict sain et suppression ; les clés de stockage,
  métadonnées de reprise et raisons internes ne sont jamais sérialisées ;
- défense en profondeur au téléchargement : tout verdict lié non sain ou encore
  quarantiné est bloqué avant la résolution du stockage ; les versions
  historiques non liées restent compatibles et sont marquées non vérifiées.

La frontière et le passage observation vers blocage sont décrits dans l'ADR
frontend `ADR-0059-document-antivirus-quarantine.md`. Hors tests, le service
reste fail-closed : le mode observation sert à mesurer avant publication et ne
rend jamais un fichier GED consultable sans verdict sain.

## Fichiers modifiés

- `src/module/ged/` : service, coffre, dépôt, contrôleurs, routes et types de la
  quarantaine ;
- `src/shared/uploads/` : staging différé et provenance du scanner ;
- `src/shared/observability/{metrics,health}.ts` : résultats de scan, volume et
  âge de quarantaine ;
- `src/middlewares/errorHandler.ts` : messages publics sûrs ;
- `db/patches/20260811_ged_antivirus_quarantine.sql` et fichiers support ;
- `Dockerfile`, `.gitattributes` : exécution Linux reproductible depuis Windows ;
- tests GED, RBAC, migration, téléchargement, métriques et image Docker ;
- `docs/upload-hardening.md` et ce rapport.

## Migration et données

La migration additive complète `ged_upload_sessions`, lie
`ged_document_versions.upload_session_id`, étend les événements d'audit et pose
deux triggers : publication uniquement après verdict sain et immutabilité du
verdict publié (seul l'effacement post-commit de la clé de quarantaine est
autorisé). Le preflight est en lecture seule ; le rollback refuse toute base
autre que `cerp_test`, exige `cerp.migration_rehearsal=1` et refuse les versions
SOL-11 déjà liées.

Preuve sur PostgreSQL 16 Docker jetable, sans accès production :

- inventaire complet appliqué : `142` patches, `0` pending, `0` checksum mismatch ;
- dump avant : `1 965 189` octets, SHA-256
  `35e06b1661d54e4317e724556df12f246ccc4f020848b77551dfe4789d14072a` ;
- dump après : `1 970 654` octets, SHA-256
  `d5049cf23f5c058673d91adfdbd7f5e2088bef93c7ab3433f657224865a42113` ;
- preflight et verify : tous les contrôles vrais ; application rejouée sans
  erreur ; smoke transactionnel : pending bloqué, clean accepté, verdict publié
  immuable et nettoyage de clé autorisé ;
- rollback gardé réussi, puis restauration réelle des dumps avant et après dans
  deux bases isolées avec schémas, triggers et comptages conformes ;
- conteneur et bases jetables supprimés. Aucune base réelle n'a été écrite.

## Tests et preuves

| Commande / scénario | Résultat |
|---|---|
| tests SOL-11 ciblés | PASS, 5 fichiers / 32 tests |
| EICAR service + quarantaine durable | PASS, publication absente, `422`, audit présent |
| scanner indisponible | PASS, fail-closed `503`, fichier durable |
| RBAC utilisateur standard | PASS, 4 routes refusées sans lecture DB |
| téléchargement d'un verdict infecté | PASS, blocage avant accès stockage |
| guards migration | PASS, 4 tests |
| `npm run build` | PASS, TypeScript et frontière 625 source / 625 émis |
| `npm run test:run -- --reporter=dot --silent=passed-only` | PASS, code retour 0 en 17,7 s |
| `docker build -t cerp-backend-sol11-verify:local .` | PASS |
| `CERP_SCANNER_SMOKE=1` dans l'image | PASS, ClamAV 1.4.5, EICAR infecté, limite de récursion infectée, fichiers sains propres |

Le premier passage de la suite complète a correctement signalé deux assertions
statiques anciennes : SOL-06 supposait être le dernier patch et le contrat GED
cherchait l'ancien nom de fichier avant promotion. Les invariants ont été rendus
compatibles avec les migrations ultérieures et la copie de libération, puis la
suite complète a été rejouée avec succès. Aucun timeout ni test n'a été désactivé.

## Vérification navigateur / E2E

Aucun composant visuel n'est modifié par SOL-11. Une vérification navigateur ne
constituerait donc pas une preuve supplémentaire. Le comportement utilisateur
est couvert au niveau HTTP/service par Supertest et Vitest, tandis que le moteur
réel est couvert dans l'image de release. Une interface d'administration de la
quarantaine reste une amélioration séparée ; les opérations sont disponibles
dès maintenant via API protégée et runbook.

## Risques et compatibilité

- les versions historiques, antérieures à SOL-11, n'ont pas de verdict durable :
  elles restent accessibles pour compatibilité avec une fiabilité
  `HISTORICAL_UNVERIFIED` ; un backscan est recommandé avant exigence stricte ;
- le modèle GED actuel ne porte pas de société/site : l'isolation appliquée est
  l'authentification et le RBAC existants, sans prétendre à un multitenant absent ;
- après publication, un échec rare du nettoyage SQL peut laisser une clé de
  quarantaine `released` devenue obsolète ; il est journalisé et n'expose pas le
  fichier, mais mérite un futur reconciler de maintenance ;
- le seuil 512 MiB et les limites ClamAV augmentent le besoin mémoire. Le runbook
  exige une mesure sur chaque cible avant activation pilote.

## Rollback

Avant déploiement : sauvegarder DB et coffre GED, exécuter preflight, appliquer le
patch, vérifier, puis déployer l'image. Pour revenir en arrière sans donnée liée,
arrêter les uploads, définir l'autorisation de rehearsal sur une copie de test et
exécuter le rollback support, puis redéployer le commit précédent. Dès qu'une
version référence une session SOL-11, ne pas supprimer les colonnes/triggers :
redéployer l'ancienne application en conservant le schéma additif ou restaurer
ensemble la sauvegarde DB et le coffre GED. Ne jamais supprimer la quarantaine
avant preuve de restauration.

## Reste réellement à faire

- appliquer la migration en environnement de validation puis en production
  uniquement dans une fenêtre SOL-06 avec sauvegarde et contrôles opérateur ;
- configurer les destinataires d'alertes et vérifier les ressources ClamAV sur
  HYPERBOX2 et Coolify ;
- effectuer un exercice pilote de réanalyse/libération/suppression avec un
  administrateur désigné ;
- planifier le backscan des versions historiques et le reconciler des nettoyages
  post-commit ;
- construire, si souhaité, le panneau admin de quarantaine en réutilisant ces API.
