# CERP — registre commun des déploiements du 26 octobre 2026

Accord confirmé par les trois chats à la demande de Keenan. Ce registre rapproche
les preuves des lots livrés et restant à livrer. Le lot Métrologie est désormais
livré en `2.0.29`, avec reçus et contrôles ci-dessous ; le chantier
multi-entreprises / Esprit Carabine reste local et ouvert.
Le premier relevé d'exploitation ci-dessous est daté du 26 octobre, vers 19:58–20:00
à Paris (CET) ; les jalons suivants sont datés dans le journal. Une nouvelle fenêtre exige de nouveaux contrôles et de nouvelles
preuves sur les SHAs réellement retenus.

## État courant — 27 octobre 2026, préparation EC 2.0.30

Le pilote Métrologie confirme sa livraison 2.0.29 sur les services atelier et
public, le feed Windows et `Z:\CERP-INSTALLATION\01-Windows`. Les sources publiées
sont backend `870c7ed07f187860570c0b714e4bb43596131119` et frontend
`3be3fe7a35d0d2ef26bbddec7543f33f472c89e3`. L'APK Android conserve sa version
indépendante 2.0.13. Aucun correctif supplémentaire n'a été publié dans ce chat
depuis cette livraison ; la fenêtre est libérée. Les journaux plus bas gardent
leur valeur historique, sans remplacer cet état courant.

Le candidat EC 2.0.30 inclut ces deux mains ainsi que le correctif 2.0.28. Ses PRs
de revue sont les brouillons backend [#1462](https://github.com/BigFootLime/erp-crp-backend/pull/1462)
et frontend [#1784](https://github.com/BigFootLime/crp-systems-web/pull/1784), ciblant
`dev` conformément à la gouvernance. Le décalage de `dev` avec les mains publiées
rend une fusion directe non qualifiée. Aucun déploiement EC, migration de
production, changement d'accès réel ni publication d'installateur EC n'a eu lieu.

La prochaine livraison doit préserver l'alias natif et VPS
`documents/legacy-import` vers `metrologie/legacy-import`, associé au stockage
immuable `uploads/docs/legacy-import`. Les 921 références et 838 blobs vérifiés
par Métrologie font partie des contrôles de conservation. Ses 364 instruments,
1 035 historiques et 921 références sont présents en production et test commun ;
aucune donnée métier n'a été chargée dans le template.

Les préflights en lecture seule montrent l'annuaire partagé déjà activé et le
multi-entreprises encore désactivé. Aucune table `cerp_business_%` n'est encore
présente. La mise en service EC nécessite donc le provisionnement séparé de
l'autorité et des bases métier, pas seulement la copie d'un installateur.
Le plan détaillé et les frontières d'approbation sont dans
[`company-site-provisioning-1454.md`](../company-site-provisioning-1454.md).

Le candidat Windows local 2.0.30 est construit depuis le frontend
`92f6f680b282f738ba89966c6732a652b2430ae8` ; il n'est pas publié. Sa publication
future doit employer exclusivement `cerp-installation-tools/publish-installation.mjs`,
d'abord sans `--apply`, puis après qualification avec `--apply`, en conservant
une unique version Windows et son manifeste cohérent dans `01-Windows`.

## Responsabilités convenues

| Responsable | Périmètre |
|---|---|
| Chat « Refondre la métrologie qualité » (`01a177f5-c238-70e1-8dbc-59b0a7c81e3e`) | Pilote unique de qualification, migration, bascule des services et publication des artefacts/installateurs. |
| Chat « Corriger les notifications ERP répét » (`01a177f9-7880-7c32-954c-49baf998a0c6`) | Conservation des correctifs temps réel/supervision ; contrôles readiness avant et après la fenêtre réelle. |
| Chat multi-entreprises / Esprit Carabine (`01a17867-f34d-78a3-8a73-61bcf9d9c2dd`) | Registre commun, code et preuves de son propre lot ; dépendances des bases métier/Directory, droits, B2C et bridge commercial. |

Aucun second déploiement concurrent n'est entrepris par les deux autres chats.
Un changement de SHA invalide l'utilisation des preuves de l'ancien candidat.
Les sources, images et fichiers validés doivent correspondre à la livraison
effectivement publiée. Aucun contenu de secret n'est enregistré ici.

## Inventaire des lots et état convenu

| Lot | Références exactes | État et portée |
|---|---|---|
| Notifications / temps réel | Backend `f15d7738e8881dbb3c8a067fceb56eba84bd3143`, PR dev backend [#1451](https://github.com/BigFootLime/erp-crp-backend/pull/1451). Supervision `b347cdf6`, dernier rapport documentaire `73cc310bb629c4620d59d81052238b33beadad2d`, PR dev frontend [#1772](https://github.com/BigFootLime/crp-systems-web/pull/1772). | Correctifs conservés et vérifiés sur les vrais points d'entrée après livraison. À 07:21:59 CET le 27 octobre : 42 contrôles sains, aucun incident actif constaté. Observations transitoires détaillées ci-dessous ; PR de traçabilité distinctes. |
| Métrologie / livraison `2.0.27` | Candidate frontend `2d5442b17e0482bd69b3221f5a5c6a3c66586d0f` / backend `15c5fc3951756fb7245e3a0111678b8cdf7fd8be`. PR main frontend [#1777](https://github.com/BigFootLime/crp-systems-web/pull/1777) / backend [#1455](https://github.com/BigFootLime/erp-crp-backend/pull/1455) fusionnées ; mains publiées `d743bd48fa70de36b200e986043c2498085bd399` / `f796d2e504f2d60417778524ead41ca9a0f596eb`. | **Livré et distribué, vérifié le 27 octobre.** Gate production PASSED, MD15 seule appliquée test → template → prod, API/UI Hyper et VPS, feed Windows et partage Z publiés. Reçus, contrôles indépendants et empreintes ci-dessous. Tous les lots entreprise/B2C/bridge restent exclus. |
| Socle multi-entreprises | Sources réintégrées sur main : backend `b599449e`, frontend `e89dcb09`, issues backend [#1454](https://github.com/BigFootLime/erp-crp-backend/issues/1454) / frontend [#1775](https://github.com/BigFootLime/crp-systems-web/issues/1775). | Local, tests ciblés/typechecks/builds réussis, correctif de portée PIN inclus. Non inclus dans la livraison `2.0.27`, pas de qualification à deux bases/services ni de mise en service. |
| B2C et primitive de commande native | Sur main : backend B2C `3aae2c1f`, frontend B2C `1d343c7a`, extraction native `7d49aab4`. Sources initiales : `16f65b9e`, `1729b7ca`, `35f7abb6`. | Parties identifiées du chantier précédent, non incluses dans `2.0.27`. B2C a une dépendance DDL même si le flag entreprise reste désactivé. |
| Catalogue / bridge EC → CRP | Issues #1454 / #1775, pas de nouveau code après les références ci-dessus au relevé. | En conception : tarif fournisseur par référence/variante confirmé, références/variantes à importer ou créer chez CRP. Achat EC, notification/acceptation CRP, stock unique, livraison directe/documents EC et deux facturations restent à raccorder. |
| Réconciliation des compteurs | Backend [#1458](https://github.com/BigFootLime/erp-crp-backend/issues/1458), ouverte au relevé. | Suivi distinct : d'anciens patches pending pourraient retirer `MTR` après MD15. Aucun `up` global, modification de checksum ou ledger artificiel. |
| Catégories après création de base vide | Backend [#1456](https://github.com/BigFootLime/erp-crp-backend/issues/1456), ouverte au relevé. | Suivi séparé ; pas de seed ponctuel implicite dans la livraison MD15. |

Le socle multi-entreprises est sur les branches locales
`feature/1454-multi-company-foundation` et
`feature/1775-multi-company-foundation`. Ses correctifs préservés séparément sont
`afb82bf6` (temps réel) et `6a6a0ddf` (supervision). Ce ne sont pas des nouveautés
à appliquer une deuxième fois sur une base qui les contient déjà.

## Journal de qualification — 26 octobre, 20:29 Paris

Point transmis par le pilote Métrologie et recoupé avec son chat : sur le couple
`b2478f609bde68990b5e0ef720b7e327f9883de2` /
`1ed5d9db9e3a8a6c5fce165ff7e0eff0acfa6d3b`, les tests unitaires frontend/backend
et les builds sont verts ; 8 642 tests backend sont annoncés. La répétition
isolée de 50 patches, avec restauration et replay, est annoncée réussie. Ces
preuves sont celles du pilote, pas de nouvelles exécutions de ce chantier.

Les parcours navigateur/Electron rencontrent encore des erreurs de fixtures
(Outillage test-only manquant, mocks Métrologie/AR) et une dépendance GTK3
manquante dans le runtime Electron privé. Le pilote prépare les corrections
isolées ; aucune correction supposée ne vaut un gate réussi. La livraison reste
**non qualifiée**, sans mutation production ni paquet publié selon son point.
Le couple de SHAs reste candidat et tout changement exigera de nouvelles preuves.
Pilotage exclusif et exclusion du lot Esprit Carabine de `2.0.27` inchangés.

## Journal de qualification — 26 octobre, 22:03 Paris

Le chat Notifications signale un incident de ressource de recette à 21:52 CET
(20:52 UTC) : le noyau VPS a tué Chrome headless du gate lors d'un OOM global.
Aucune bascule n'a eu lieu. Ce run est échoué/incomplet et ne qualifie aucun
artefact ; les étapes antérieures réussies ne remplacent pas un gate complet.

Chronologie transmise par Notifications, avec vérification Outlook de sa part :

- 21:52:29 : mémoire critique à 2 %, mail d'alerte légitime.
- 21:53:19 : une connexion PostgreSQL Hyper fermée pour timeout
  `idle-in-transaction` ; attribution non établie.
- 21:53:47 : un cycle watcher perdu par timeout.
- 21:54:11 : mémoire de nouveau saine.
- 21:56:16 : mail de rétablissement confirmé. Notifications ne trouve que ces
  deux mails dans la fenêtre ; aucun nouveau conflit/échec de polling observé.

Son relevé en lecture seule à 22:00:57 CET constate 41 contrôles sains, timers
actifs/outboxes vides, readiness publiques/natives HTTP 200. API/UI production
VPS healthy sans redémarrage ni OOMKill, services PostgreSQL/API/worker Hyper
inchangés, worker production leader avec 12 tâches. Environ 7,14 Gio disponibles
et pas de swap à ce relevé. Ce constat est daté ; il ne prouve pas l'état d'une
future fenêtre et n'attribue pas le timeout PostgreSQL à un processus précis.

Le pilote Métrologie prépare une correction de ressources de recette.
Notifications lui a demandé une réserve mémoire pour la production, une borne
du groupe de processus/concurrence et un préflight/retour arrière avant relance.
Aucune de ces préparations n'est enregistrée comme déjà appliquée ou qualifiée.
Notifications n'a modifié ni service, base, profil ni ancien conteneur ; ce
chantier reste également sans mutation d'exploitation.

## Journal de qualification — 26 octobre, 22:56 Paris

Le pilote annonce une nouvelle paire propre et poussée : frontend
`dba8ac4751b636d95fb4f00f62e518dab3012fec` / backend
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`. Ces HEAD ont été recoupés en lecture
seule dans ses worktrees. Le diff depuis la paire précédente porte sur fixtures,
runner E2E, répétition isolée et documentation, sans changement des modules
applicatifs de temps réel ou de supervision. Le pilote rapporte 49/52 parcours
ciblés réussis après correction des fixtures et des tests Electron réussis sous
Openbox privé ; cela ne constitue pas un gate global réussi. L'OOM du navigateur
reste un échec du run concerné. Aucune migration, modification de ressources ou
publication applicative n'est annoncée à ce point.

Le plan de reprise suivant est **préparé, non appliqué et non qualifié** :

- Une slice cgroup-v2 transitoire commune aux processus hôtes et Docker jetables
  de recette : `MemoryHigh=4352M`, `MemoryMax=4864M`, `MemorySwapMax=8G`,
  `CPUWeight=25`, `CPUQuota=300%`. La portée réelle pour Docker run et build doit
  être prouvée par canaris/PID ; tout OOM du groupe invalide le run.
- Réserve physique de 2048 MiB pour la production et contrôle frais
  `MemAvailable >= 7077888 KiB` avant commande. Le moteur de build partagé
  (`dockerd`/BuildKit) ne serait pas déplacé, comme aucun processus de production.
  Son usage hors slice n'est donc pas couvert par `MemoryMax` : Notifications
  demande de le compter dans la réserve effective et de prouver le budget global.
  La cohérence arithmétique seule n'atteste pas le confinement.
- Swap temporaire propre, unique, de 8 Gio maximum sous `/var/tmp`, sans
  modification de `fstab`, sysctl ou services existants. Les 15,20 % de disque
  libre passeraient temporairement à 11,13 % : warning légitime attendu sous
  15 %, sans masquer l'alerte ni modifier le seuil critique de 5 %.
- Avant clôture : arrêter seulement les enfants/unités possédés, vérifier la
  marge de `swapoff`, puis supprimer uniquement le fichier dont inode/dev/UID
  ont été enregistrés. Vérifier le retour du disque et de la santé. Nouvelle
  pression ou expiration de supervision doit arrêter la recette.

Le pilote doit transmettre scripts, préflight et reçus avant relance, avec revue
des helpers et de l'exception du moteur de build partagé. Ce registre enregistre
le plan et ses réserves ; il n'exécute ni n'approuve inconditionnellement ces
opérations. Pilotage unique et exclusion Esprit Carabine inchangés.

La conservation des sources a aussi été recoupée localement sur cette nouvelle
paire : blob Git temps réel `ed42e14c0f8cf549032ae966e9ca290a50026adc`, watcher
`957efb4794e1c5e6635f3fd11efc19ae19b8067c` et retrait des API non routées
`4c854af6a10a08a0df51a0a07f74412b96b50f63`, identiques aux sources des correctifs
d'origine. Le hash canonique LF du patch MD15 reste identique à celui enregistré
ci-dessous. Ce contrôle de sources ne valide pas des images ou artefacts à
publier, ni la santé d'une future fenêtre.

## Journal de qualification — 26 octobre, 23:14:26 Paris

Nouveau relevé vérifié du chat Notifications : **plan appliqué partiellement,
recette lourde non relancée**. Le statut « entièrement préparé/non appliqué » du
point précédent est historique. Le swap temporaire de 8 Gio est actif et
entièrement libre. `MemAvailable=7275000 KiB`, au-dessus de la garde
`7077888 KiB` à ce relevé ; cette garde reste à vérifier au vrai lancement.

Selon le pilote, les canaris hôte/Docker run sont confinés sans OOM. La preuve
PID de `Dockerfile RUN` a échoué fermée : la seule réussite d'un build ne prouve
pas sa portée mémoire. Une micro-sonde legacy `DOCKER_BUILDKIT=0`, limitée à son
wrapper, est en vérification, sans changement du daemon. Les preuves de RUN et
du budget effectif restent requises ; aucun résultat de la sonde n'est anticipé.

Notifications a contrôlé les deux hôtes en lecture seule : VPS 18 contrôles avec
un seul warning disque attendu (11 % disponibles), aucun critique ; Hyper 23
sains. Outboxes vides, timers actifs, watcher `f553…` inchangé. API/UI production
healthy sans OOMKill ni redémarrage, endpoints santé/readiness publics et natifs
HTTP 200, worker production leader/12 tâches et workers API désactivés.

Aucun nouveau mail ni timeout watcher au-delà de la fenêtre OOM de 21:52–21:56,
fermeture PostgreSQL inactive toujours unique, aucun nouveau conflit/échec temps
réel détecté selon ce relevé. L'attribution du timeout PostgreSQL reste inconnue.
L'avertissement disque reste visible ; il devra disparaître après nettoyage
avant le verdict final d'exploitation.

Aucune migration, bascule applicative, publication de feed ou écriture Z n'est
attestée par ces opérations. Le swap actif n'est ni un déploiement de CERP ni une
qualification du gate. Les constats de santé sont datés et ne prouvent pas un
futur état.

## Complément de preuve — reçu Dockerfile RUN du 26 octobre, 23:13:30 Paris

Notifications a reçu et lu directement un reçu positif de la micro-sonde RUN,
daté 22:13:30 UTC (23:13:30 CET), connu après le point précédent :
`/tmp/cerp-metrology-gate-20261026-resource-canary-20261026-215913/legacy-run-probe-cerp-legacy-run-resource-canary-20261026-215913-4028396.receipt`.
Il atteste `DRIVER=legacy`, PID `4028498`, marqueur attendu et `PID_CGROUP` sous
la `SLICE_CGROUP` prévue, dans le scope
`docker-bcdd0fe085f09552e48159d977e83e75c24203a5e8769dfd70fd6249614e71cb.scope`.
Ce reçu confirme le rattachement RUN de cette sonde ; il ne qualifie ni un run
futur ni un artefact. Le constat négatif antérieur reste l'historique d'une
preuve alors manquante, pas le statut final de cette micro-sonde.

La limitation est explicite : `DOCKER_BUILDKIT=0` dans le seul wrapper privé,
buildx refusé, image locale épinglée et réseau `none`. Le contexte et l'image du
canari ont été nettoyés selon le compte rendu ; aucun changement du daemon.
Le pilote finalise encore le contexte `git archive` du HEAD backend propre.

Statut communiqué : swap actif et canaris hôte/Docker run/RUN prouvés ; contrôle
mémoire frais et smoke du wrapper final encore requis. Recette lourde non
relancée, aucun déploiement, migration, feed ou partage Z publié. Le dernier
constat serveur indépendant reste celui de 23:14 CET, sans lui attribuer une
fraîcheur nouvelle lors de la réception de ce complément.

## Complément suivant — test final du wrapper et reprise ciblée préparée

Le pilote annonce le smoke final du wrapper et du contexte `git archive` réussi :
legacy build exit 0, PID `4083353` sous la slice propriétaire et scope Docker
`d887…`, compteurs mémoire/OOM à zéro. Notifications relaie aussi la rectification
du pilote : **la copie/archivage de `final-wrapper-smoke.receipt` n'est pas encore
attestée**. Le helper d'archivage est corrigé pour les noms legacy/final-smoke et
une copie manuelle est exigée pour ce canari. Ne pas marquer l'archive terminée
avant le reçu de copie ; une annonce de succès ne remplace pas cette preuve.

Le pilote prépare uniquement la reprise focused des trois fichiers ciblés déjà
retenus, workers 1, retries 0, gestionnaire de fenêtres privé, groupe 4864 MiB,
swap maximum 8 GiB et CPU 300 %. Ce point n'atteste pas encore son lancement :
un reçu réel reste attendu. Le manifeste du pilote doit identifier les fichiers
et la commande ; leurs noms ne sont pas déduits du présent compte rendu.

L'opérateur rapporte `MemAvailable=7173244 KiB`, supérieur à la garde
`7077888 KiB`, ainsi que 4,49 Gio libres sur `/tmp` et 22,9 Gio sur `/`.
Ces chiffres sont rapportés, pas un nouveau relevé indépendant de Notifications,
dont le dernier contrôle serveur reste à 23:14 CET.

Notifications a vérifié directement que le watcher et le module temps réel de
la paire `dba8ac4751b636d95fb4f00f62e518dab3012fec` /
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be` restent identiques aux correctifs LF.
Le run focused demeure distinct du futur gate complet ; aucune qualification
globale ni publication ne découle des contrôles de sources ou du smoke.

## Journal de reprise ciblée — 26 octobre, 23:31:39 Paris

Notifications a vérifié la chronologie : le premier lancement
`focused-dba8-20261026T222826Z-4116951` a été refusé avant les tests
(`invalid run id`, log de 15 octets, wrapper absent). Il ne doit pas être compté
comme une exécution des tests. Le lancement corrigé réel est
`focused-dba8-20261026-222902-4120797`, wrapper `4120811`, sur la paire
`dba8ac4751b636d95fb4f00f62e518dab3012fec` /
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`, trois fichiers seulement.

À 23:31:39 CET, Notifications constate scope/anchor running et slice active,
limites effectives 4352 MiB High / 4864 MiB Max / 8 Gio swap / CPU 300 %,
`memory.events` tous à zéro, `swap.current=0`, pic d'environ 3,74 Gio. Les vrais
tests Node/Electron, WM/Xvfb et PostgreSQL jetable sont observés sous le groupe
propriétaire, puis un `docker run` avec le bon `--cgroup-parent`. Le wrapper de
contrôle lui-même est hors groupe ; ce constat distingue le contrôleur des tests
observés dans le scope. Ce sont des preuves datées d'exécution/confinement, pas
encore un résultat final du run focused.

Le pilote annonce l'archivage de 12 preuves sur Windows avec manifeste SHA-256 ;
Notifications ne l'a pas encore relu indépendamment. Cela remplace l'attente
d'une copie annoncée par un archivage rapporté, sans lui attribuer une
attestation indépendante absente.

Un bref processus `docker-buildx` a été observé dans le scope puis a disparu.
L'opération n'a pas été capturée ; son nom seul ne prouve pas un contournement.
Notifications a transmis au pilote le rapprochement nécessaire avec les reçus
et autodétections CLI, puisque le plan refuse buildx. Ce point reste à éclaircir,
sans transformer une observation de nom en violation établie.

Le contrôle production indépendant de Notifications à 23:29:42 CET est sain :
pas de restart/OOMKill, endpoints publics/natifs HTTP 200, Hyper 23 contrôles
sains, VPS 18 avec le seul warning disque à 11 %, outboxes vides/timers actifs.
Aucun nouvel incident mémoire/watchdog/santé ni mail dans la fenêtre observée ;
les événements de 21:52–21:56 restent les seuls rapportés. Ce relevé remplace
celui de 23:14 comme dernier constat indépendant reçu, sans garantir un futur
état. Aucun gate global, déploiement, migration, feed ou partage Z n'est qualifié
par ces contrôles.

## Journal de reprise ciblée — arrêt rapporté à 23:34, contrôle à 23:35 Paris

Le pilote rapporte que `focused-dba8-20261026-222902-4120797` a été arrêté
volontairement par l'opérateur vers 22:34 UTC (23:34 CET), après interprétation
incorrecte du seul compteur `high=2466`. Aucun événement OOM/max/oom_kill n'est
signalé pour cet arrêt. Statut : **interrompu et non qualifié**, aucun gate
complet lancé.

La [documentation officielle du noyau](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files),
également consultée pour ce registre, distingue le dépassement de `memory.high`
(ralentissement et récupération de mémoire) des événements OOM. Le compteur
`high` ne prouve pas, à lui seul, qu'un OOM killer est intervenu.

Le pilote corrige sa règle de surveillance : `high` seul n'est plus un arrêt ;
arrêt sur OOM réel, réserve hôte inférieure à 2 Gio de manière soutenue ou à
1 Gio immédiatement, ou nouveau défaut santé/watchdog/critique. La durée et le
mode d'évaluation de « soutenue » restent à préciser dans les reçus avant
relance. L'analyse de l'observation `buildx` reste également préalable.

Le contrôle indépendant Notifications à 23:35:35–36 CET trouve une production
saine des deux côtés, API/UI sans restart/OOMKill, endpoints HTTP 200 et cinq
dépendances disponibles. Hyper : 23 contrôles sains ; VPS : 18 avec le seul
warning disque à 10 %. Timers actifs/outboxes vides, watcher `f553…` inchangé,
`MemAvailable=7308200 KiB`. Swap temporaire de 8 Gio actif, avec environ
**69 MiB utilisés** : il n'est plus entièrement libre à ce relevé.

Aucun nouvel OOM, health 5xx, échec temps réel ou perte de leader rapporté.
Les deux mails, le timeout watcher et la fermeture PostgreSQL inactive restent
ceux de l'incident initial. Le pilote annonce le nettoyage du budget, en
conservant le swap temporaire ; nettoyage non attesté terminé dans ce point.
Pas de publication, migration ou bascule attestée. Les constats de santé restent
datés et ne qualifient pas une relance future.

## Journal de nouvelle reprise ciblée — 26 octobre, 23:38:53–54 Paris

Le pilote a identifié la cause de l'observation `buildx` : le premier run focused
utilisait encore un ancien template serveur malgré le nouveau launcher. Ce run
reste interrompu/non qualifié ; aucune preuve legacy d'un autre canari ne doit
lui être transférée. L'explication remplace le statut « cause inconnue », sans
effacer le défaut de correspondance des scripts alors exécutés.

Le pilote a repris ses lancements et transféré cinq fichiers figés, avec hashes
contrôlés, sous
`/tmp/cerp-metrology-2.0.27-gate/resource-root-frozen-20261026-2238`.
Le wrapper matérialisé est annoncé identique octet par octet, SHA-256
`ffc4bd6c2e97403d8c2a0b078aa13428c0458226e857ea081d1413a17f4a2e35`.
Nouvelle relance réelle : `rootfocused-dba8-20261026-223647-4175792`, PID
`4176007`, à 22:36:47 UTC (23:36:47 CET), paire frontend `dba8ac47…` /
backend `15c5fc39…` déjà identifiée intégralement dans l'inventaire.

Notifications a contrôlé indépendamment à 23:38:53–54 CET : scope/anchor running,
slice active, Node/Electron/WM/Xvfb/esbuild et PostgreSQL jetable observés sous
les descendants du budget. Limites 4352 MiB high / 4864 MiB max / 8 Gio swap /
CPU 300 %, courant/pic d'environ 3,15 Gio ; high/max/oom/oom_kill à zéro à cet
instant et swap du groupe à zéro. Mémoire hôte disponible d'environ 3,91 Gio,
au-dessus de la réserve de 2 Gio, et swap hôte d'environ 47 MiB utilisés : le
swap du groupe et celui de l'hôte sont des observations distinctes.

La règle d'arrêt est maintenant précisée : réserve inférieure à 2 Gio sur deux
relevés espacés de dix secondes ; seuil inférieur à 1 Gio ou OOM réel immédiat.
`high` seul reste une métrique. Cette précision lève l'absence de définition de
la fenêtre « soutenue » dans le compte rendu précédent ; elle ne constitue pas
un verdict final sur le nouveau run.

Au même contrôle, Notifications constate une exploitation saine, API/UI sans
restart/OOMKill, endpoints HTTP 200 et cinq dépendances disponibles, worker
production leader avec 12 tâches. Hyper 23 contrôles sains, VPS 18 avec le seul
warning disque à 10 %, outboxes vides/timers actifs/watcher `f553…` inchangé.
Seuls les événements OOM/watchdog/mails initiaux demeurent dans l'historique ;
aucun nouveau symptôme actif rapporté. Recette ciblée observée en cours, aucun
verdict global, migration, bascule, feed ou partage Z attesté.

## Jalon focused réussi / gate candidate complet lancé — 26 octobre, 23:47:57–58 Paris

Le pilote atteste le focused `rootfocused-dba8-20261026-223647-4175792` réussi :
10/10 tests, access-scope 4/4, runtime 745 événements et zéro bloquant,
skipped/flaky/unexpected à zéro, budget exit 0. Compteur `high=6839` conservé
comme throttling ; max/oom/oom_kill/group_kill à zéro. Les preuves sont annoncées
copiées et hachées **avant nettoyage**, sous
`/tmp/cerp-metrology-2.0.27-gate/cgroup-audit/focused-passed-rootfocused-dba8-20261026-223647-4175792`.
Le budget focused a été nettoyé. Il s'agit de la qualification ciblée attestée
par le pilote, pas encore d'une qualification globale de release.

Le gate candidate complet de la même paire frontend
`dba8ac4751b636d95fb4f00f62e518dab3012fec` / backend
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be` a été lancé à 22:46:09 UTC
(23:46:09 CET) : `rootcandidate-dba8-20261026-224609-50344`, PID `52584`.
Log `/tmp/cerp-metrology-2.0.27-gate/rootcandidate-dba8-20261026-224609-50344.launch.log`
et reçu homonyme. Cinq helpers aux hashes contrôlés ; wrapper matérialisé annoncé
SHA-256 `c20465e050ee117c2069d0535b0ed5c3aa4120d97e03e9a45801742599e3ae7c`.
Ce wrapper du gate complet est distinct de celui du focused et ne doit pas
hériter automatiquement de ses preuves.

Le contrôle indépendant Notifications à 23:47:57–58 CET constate scope/anchor
running et slice active, limites 4352 MiB high / 4864 MiB max / 8 Gio swap /
CPU 300 %. Pic d'environ 2,85 Gio, courant d'environ 1,33 Gio, événements mémoire
et OOM tous à zéro à cet instant, swap du groupe à zéro, mémoire hôte disponible
d'environ 5,71 Gio. Ces mesures attestent le point observé, pas tout le futur run.

Production saine des deux côtés à ce relevé, sans nouveau restart/OOMKill,
health 5xx, échec temps réel ou perte de leader ; endpoints HTTP 200 et
dépendances disponibles, worker production leader/12 tâches. Outboxes vides,
timers actifs, seul warning disque à 10 %. Aucun nouveau mail ou timeout
watchdog après l'incident initial rapporté.

Statut : **focused qualifié selon le pilote, gate candidate complet en cours**.
Pas encore de qualification complète, promotion main, migration, bascule, feed
ou partage Z attesté. Pilotage unique et exclusion du lot EC inchangés.

## Journal FULL — 27 octobre, 00:23:55–56 Paris

Le pilote atteste 4 286 tests frontend dans 622 fichiers et 8 643 tests backend
dans 824 fichiers réussis, ainsi que les builds, seuils bundle et répétition de
migration. Les E2E sont encore en cours, environ 60/365 à 00:22 CET
(26 octobre 23:22 UTC). Ce sont des jalons rapportés du run complet ; absence
de header rouge et réussites intermédiaires ne constituent pas un verdict global.

**Un signal de santé a été observé pendant cette fenêtre.** Le contrôle
indépendant Notifications a trouvé les événements suivants sur l'API VPS
production, horodatés le 27 octobre en heure de Paris :

- 00:04:59,278 : `/health/ready` HTTP 503, durée 1 506 ms
  (journal UTC du 26 octobre `23:04:59.278`).
- Watcher : `database:PROBE_TIMEOUT`, warning une fois, retour OK à 00:06:04 ;
  aucun mail supplémentaire.
- 00:05:18,457 : échec de polling temps réel, récupération à 00:05:18,744,
  soit environ 287 ms.
- 00:05:26 : échec de convergence de présence.

Pas d'événement PostgreSQL Hyper correspondant ni d'ancien conflit d'allocateur
détecté. **L'attribution à la charge des tests n'est pas établie.** Le pilote a
été immédiatement alerté par Notifications pour traiter le signal selon sa
règle d'arrêt santé. Sa disposition reste à consigner ; ce run ne doit pas être
présenté comme sans anomalie de santé observée, ni qualifié par le seul retour
ultérieur au vert.

Au contrôle indépendant à 00:23:55–56 CET, endpoints publics/natifs HTTP 200 et
cinq dépendances disponibles, API/UI sans restart/OOMKill, worker production
leader/12 tâches. Hyper 23 contrôles sains, VPS 18 avec le warning disque à 10 %
uniquement ; timers actifs/outboxes vides/watcher `f553…` inchangé. Aucun nouvel
OOM, timeout watchdog ou mail ; la fermeture PostgreSQL inactive reste celle de
l'incident initial.

Scope/anchor/slice FULL encore actifs au relevé : réserve hôte d'environ
4,36 Gio, groupe d'environ 2,69 Gio et swap du groupe d'environ 1,92 Gio,
`high=7361`, `max=0`, `oom=0`. Les observations de swap à zéro des points
précédents sont historiques, pas l'état de ce relevé. Aucune mutation
d'exploitation de Notifications, publication, migration ou bascule attestée.

## Disposition du pilote — FULL VPS interrompu après le signal de santé

Le pilote Métrologie confirme avoir interrompu
`rootcandidate-dba8-20261026-224609-50344` et nettoyé exclusivement son budget et
ses conteneurs, sans reset de production. Il annonce les preuves hachées sous
`/tmp/cerp-metrology-2.0.27-gate/cgroup-audit/full-interrupted-health-rootcandidate-dba8-20261026-224609-50344` :
`stop.receipt`, rapport interrompu et métriques. Ce point répond à la disposition
attendue dans le relevé précédent ; la qualification est **refusée pour ce run
interrompu**, même si les tests unitaires, builds et répétitions avaient réussi.

La chronologie reste précise : `database:PROBE_TIMEOUT` / 1 506 ms à
23:04:59 UTC, retour OK au cycle de 23:06 ; polling temps réel ensuite à
23:05:18 UTC, récupéré en environ 287 ms. Ces événements ne sont pas simultanés
et la causalité des tests n'est toujours pas établie. Le traitement conservatoire
du signal ne vaut pas diagnostic de sa cause.

Le pilote prépare un runner local Windows pour séparer la recette du VPS :
Docker Desktop/WSL déjà installés, démarrage réversible de l'application,
sans installation ou configuration globale annoncée. Cette préparation n'est
pas enregistrée comme une relance déjà réussie. Les ressources temporaires VPS
restent à nettoyer précisément, avec reçus, avant le verdict final d'exploitation.

Aucune application, migration, publication de feed ou écriture Z effectuée selon
le pilote. Le chat multi-entreprises se limite à ce registre et ne démarre ni
runner, ni opération Docker/Windows, ni déploiement concurrent.

## Diagnostic borné Notifications — 27 octobre, 00:34 Paris

Le diagnostic en lecture seule recense, pour le runtime API actif depuis le
26 octobre 12:01 UTC, 775 réponses ready 200 et six ready 503 : cinq
`database:PROBE_TIMEOUT` isolés à 12:40, 14:01, 16:53, 17:29 et 23:04 UTC,
et un événement GED/médias à 20:18 UTC. Ces heures sont celles du 26 octobre en
UTC. Les premières occurrences précèdent le dernier FULL commencé à 22:46 UTC,
mais des plages hors **toutes** les recettes ne sont pas attestées : aucune
causalité ni exonération de la charge des tests ne peut en être déduite.

Dernier polling en erreur à 23:05:18 UTC, rétabli en environ 287 ms. Sa trace
limitée à `error.name` ne donne ni SQLSTATE, durée détaillée ou état de pool.
Notifications ne détecte aucun `database_pool_error`, ni message PostgreSQL
ERROR/FATAL/WARNING près du dernier 503, ni événement proxy/noyau réseau/OOM
ciblé correspondant. L'absence de ces traces ne constitue pas un diagnostic
positif de la cause.

Le périmètre PostgreSQL a été clarifié ensuite par Notifications : il s'agit de
**deux événements distincts**, sans correction de fuseau.

- A : 18:28:59,949 CET = 17:28:59,949 UTC, proche du ready 503 de 17:29 UTC,
  trouvé dans les fenêtres de -30/+60 secondes autour des six ready 503 recensés
  depuis 12:01 UTC.
- B : 21:53:19 CET = 20:53:19 UTC, trouvé dans le relevé depuis 20:50 UTC autour
  de l'incident mémoire de 21:52 CET. Une trace `database_client_error` suit à
  20:53:41,790 UTC avec code `25P03`, sans attribution certaine à la même connexion.

Le terme « unique » du diagnostic signifie un seul événement dans les six
fenêtres de 90 secondes, pas dans tout l'historique de la journée. Ni compte
global exhaustif ni attribution à une table/connexion ne sont attestés.

À ce point, Notifications rapporte santé publique/native HTTP 200 et dépendances
disponibles, API/UI sans restart/OOMKill, worker/12 tâches, timers à jour,
outboxes vides. Le warning disque à 10 % reste lié aux ressources temporaires,
dont le swap que le pilote doit retirer selon ses gardes ; pas de nettoyage
final attesté.

La vérification Outlook indépendante de Notifications recense **quatre mails
depuis la bascule** : les incidents mémoire critiques de 20:14 et 21:52 CET et
leurs rétablissements. Ce périmètre est plus large que les deux mails de la
seule fenêtre 21:52–21:56 ; aucune contradiction de comptage n'en est déduite.
Aucun spam warning, aucun abaissement de sonde ou seuil annoncé. Synthèse
transmise au pilote ; FULL interrompu toujours non qualifié, préparation du
runner Windows seulement et aucun déploiement attesté.

Traçabilité complémentaire : le [rapport supervision au commit `dbc92435`](https://github.com/BigFootLime/crp-systems-web/blob/dbc92435ad48aea753ec72cae56c47168ed26d9e/docs/testing/supervision-1771-20261026.md)
est publié dans la PR frontend #1772 selon Notifications. La métadonnée GitHub
du commit a été vérifiée : seul `docs/testing/supervision-1771-20261026.md` change.
Il ne modifie donc pas le code candidat. Le pilote a reçu la demande de dispositif
de nettoyage exact des tests/swap et de ses preuves avant verdict d'exploitation
final. Cette référence documentaire ne clôt ni le gate ni les reçus attendus.

## Nettoyage vérifié indépendamment — 27 octobre, 01:16 Paris

Notifications a terminé le contrôle en lecture seule : les sept fichiers du
manifeste `SHA256SUMS` correspondent. Le swap temporaire est absent de
`/proc/swaps`, son fichier exact n'existe plus et `SwapTotal=0`. Les deux
`RUN_ROOT` ainsi que conteneurs, volumes, réseaux, unités et processus des
recettes visées sont absents. Les deux images de test sont également absentes,
contrôlées par leurs SHA-256 complets, y compris sans étiquette.

Au relevé, disque libre à 15,66 % et mémoire disponible d'environ 6,30 Gio.
Les 41 contrôles sont sains, outboxes vides et timers actifs. API/UI actives
inchangées, sans redémarrage/OOMKill ; endpoints publics/natifs contrôlés HTTP
200, dépendances requises disponibles, worker production leader avec 12 tâches.
Aucun nouveau 503, polling défaillant ou OOM observé depuis les incidents déjà
consignés. Le warning disque temporaire n'est donc plus actif à ce point.

Contrôle publié par Notifications dans la PR frontend #1772, au [rapport du
commit `bd1ea753`](https://github.com/BigFootLime/crp-systems-web/blob/bd1ea7536f8615834c238767543555e4e4083adb/docs/testing/supervision-1771-20261026.md).
Métadonnée GitHub vérifiée : seul ce document est modifié, pas le code candidat.
**Point nettoyage levé** sur cette preuve indépendante ; les attentes de retrait
du swap et des budgets dans les entrées précédentes sont désormais historiques.

Ce contrôle ne qualifie pas le FULL interrompu et ne prouve pas la cause des
anciens timeouts. Il ne constate aucune publication applicative, migration,
publication de feed ou écriture Z. La santé est celle du relevé de 01:16, pas
une garantie d'une future fenêtre de recette ou de déploiement.

## Gate candidate Windows démarré — 27 octobre, point à 02:10 Paris

Le pilote rapporte un démarrage réel du gate candidate canonique, configuré sans
skip, sur le poste Windows à 01:00 UTC (02:00 CET). Même paire frontend
`dba8ac4751b636d95fb4f00f62e518dab3012fec` / backend
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`, clones propres. Identifiant de rapport
transmis aussi par Notifications :
`20261027T010117Z-candidate-dba8ac47-15c5fc39`.
Douze premières phases annoncées passées, tests frontend encore en cours,
sans verdict global.

Le pilote annonce Job Windows et Docker WSL bornés et placement build RUN
prouvé. Les références ont ensuite été reçues et relues localement dans le
complément ci-dessous. Ne pas copier les bornes du VPS sur ce runner différent.
Ce point atteste un démarrage, pas une qualification complète.

Notifications a contrôlé indépendamment la production à 02:10 CET : 41 contrôles
sains, outboxes vides et timers actifs, API/UI inchangées sans restart/OOMKill,
endpoints publics/natifs HTTP 200 et dépendances disponibles, worker production
leader/12 tâches. `SwapTotal=0`. Aucun nouveau 503 ou polling défaillant observé
depuis les événements documentés, donc aucun depuis le nettoyage. La cause
historique des timeouts reste inconnue.

Plus de test long sur VPS annoncé ; les chats multi-entreprises et Notifications
restent sans opération parallèle. Aucun main fusionné, déploiement applicatif,
migration, feed ou partage Z annoncé. Le prochain jalon du pilote reste le
verdict physique candidate, puis les SHAs main et un gate production complet
local. Le lot EC reste exclu de `2.0.27`.

## Références et lecture des reçus Windows — 27 octobre, vers 02:12 Paris

Base d'audit locale :
`C:/Users/KeenanMARTIN/AppData/Local/Temp/cerp-metrology-deploy-audit-20261026`.
Reçu lu :
`local-full-candidate-2026-10-27T01-00-08-362Z/launch.receipt.json`, avec
`controller.log` dans le même dossier. Il porte `state=running`, début
`2026-10-27T01:00:08.368Z`, controller PID `40488`, Job PID `44700`, les SHAs
exacts `dba8ac4751b636d95fb4f00f62e518dab3012fec` /
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`. Préflight enregistré :
11 207 323 648 octets disponibles Windows et guest working set de
5 943 721 984 octets. Ce sont les mesures du préflight, pas des mesures actuelles.

Rapport relu directement :
`C:/Users/KeenanMARTIN/Documents/Github/cerp-metrology-local-gate-web/outputs/release-gate/20261027T010117Z-candidate-dba8ac47-15c5fc39/report.json`.
Il porte `target=candidate`, `verdict=running`, début `01:01:17.824Z`, douze
phases passed (installations figées, runbooks, secrets, frontières de données,
dépendances, typechecks et lint frontend), puis `frontend-tests=running`.
Les logs de phase sont référencés par ce rapport. Aucun succès final n'est
déduit de ce document encore en cours d'écriture.

JobRoot :
`C:/Users/KeenanMARTIN/AppData/Local/Temp/cerp-md15-local-gate/cerp-local-runner-root-ad1ef820efd34205b2324129593ed4e8`,
avec `stdout.log` et `stderr.log`. Le reçu Job est émis en lignes structurées
dans `controller.log` : limite commit 5 905 580 032 octets, CPU rate 1666/10000,
priorité BelowNormal, `CHILD_ASSIGNED_TO_EXPLICIT_JOB=True`, child PID `48752`.
Le binaire vivant du PID `44700` correspond au helper figé
`local-runner-frozen-20261027-v1/RootJobGateRunner.exe`. Le code figé porte
KillOnJobClose ; la limite Job est une limite de commit, pas un relevé de RAM.
Le pilote indique un hardcap CPU d'environ quatre cœurs sur 24.

Les cinq hashes du manifeste
`local-runner-frozen-20261027-v1/SHA256SUMS` ont été recalculés localement et
correspondent : `RootJobGateRunner.cs/.exe`, `docker-proxy/helperNode.mjs` et
`docker-proxy/docker.cs/.exe`. Aucun helper n'a été exécuté par cette vérification.

Preuves relues sous `local-runner/` : `local-docker-run-proof.json` est passed
(PID `9619`, `memoryMax=3221225472`) et `local-root-build-proof.json` est passed
(PID `13823`, legacy, contexte `git archive` exercé/nettoyé, build exit 0).
Leurs cgroups réels sont sous `/cerp-metrology-gate-20261027-local`, comme leur
parent configuré. Ce sont des sondes datées, pas une observation de tous les
processus futurs du gate.

Le pilote décrit les autres bornes : Docker mémoire 3 Gio/high 2,5 Gio/swap
8 Gio/CPU 4/pids 2048, VM WSL 7 Gio/8 CPU/swap 8 Gio temporaires. La limite
Docker de 3 Gio a été relue dans le reçu ; les autres paramètres restent ceux
rapportés par le pilote dans ce point. Son état durable est
`MD15-RELEASE-STATE.json`, champ `localFullCandidate`. La disponibilité de ces
références lève l'attente documentaire, sans qualifier le run en cours.

## Premier FULL Windows échoué / relance v3 — 27 octobre, vers 02:23 Paris

Le premier rapport `20261027T010117Z-candidate-dba8ac47-15c5fc39` porte désormais
`verdict=failed`, étape `frontend-tests=failed`, constaté par relecture locale.
Le pilote rapporte 621 fichiers / 4 283 tests réussis ; les trois tests de
`catalogue-source.test.ts` ne se chargent pas parce que son chemin par défaut
`../backend` ne correspond pas au clone `cerp-metrology-local-gate-backend`.
Il indique une correction du seul lanceur avec la variable existante
`CERP_TOOL_CATALOGUE_ROOT` vers les ressources exactes du backend `15c5fc39…`,
sans modification métier ou source candidate. Préflight catalogue de trois tests
annoncé réussi avant relance. Ces résultats partiels ne requalifient pas le
premier rapport échoué.

Le pilote indique pour le premier Job un pic de commit de 3 236 638 720 octets,
exit 1 et zéro OOM cgroup/guest. La préparation v2 a refusé avant lancement sur
réserve conservatrice : elle n'est pas comptée comme une exécution complète.
La v3 conserve Job 5 632 MiB / WSL 7 Gio / cgroup 3 Gio, avec réserve physique
Windows de 2 Gio et watchdog annoncé identique.

Nouveau reçu lu : sous la base d'audit,
`local-full-candidate-2026-10-27T01-21-32-135Z/launch.receipt.json`, état running,
UTC `01:21:32.176Z` (02:21:32 CET), controller PID `22300`, Job PID `48952` et
même paire complète `dba8ac4751b636d95fb4f00f62e518dab3012fec` /
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`. Préflight enregistré :
9 651 027 968 octets Windows disponibles / guest working set 5 983 698 944 octets.
Le controller confirme limite commit `5905580032`, CPU rate `1666`, child
assigné au Job et PID `32380`.

Le manifeste `local-runner-frozen-20261027-v3/SHA256SUMS` a été recalculé :
SHA-256 `b6119518d1b7a471cb7c3a1bde2fff7fcddc1ae23ff67981df9b1792f8fcf081`,
conforme à la référence du pilote. Il couvre huit fichiers : les cinq helpers
précédents, `candidate-bootstrap.mjs`, `launch-candidate.mjs` et
`preparation.receipt.json`. Les huit hashes correspondent ; aucun fichier n'a
été exécuté par cette vérification.

Nouveau rapport relu dans le même dossier `outputs/release-gate` :
`20261027T012135Z-candidate-dba8ac47-15c5fc39/report.json`, target candidate,
début `01:21:35.98Z`, verdict running, douze étapes passed puis frontend-tests
running au relevé. Le premier verdict et les premières preuves restent séparés
de cette relance sans skip. Aucun merge main, déploiement applicatif, migration,
feed ou partage Z attesté.

## Préparation du cache builder VPS — 27 octobre, 02:35:20 Paris

Le pilote rapporte le précache d'une image builder Node épinglée, auparavant
absente, à 01:35:20 UTC (02:35:20 CET). Durée 2,35 secondes et 57,6 Mo de couches
compressées déclarées ; ce volume ne mesure pas l'occupation décompressée.
Il annonce la vérification de l'ID `91d56b2d…` et du RepoDigest `a0b9…` ; les
identifiants complets sont à consulter dans son reçu, pas à reconstruire depuis
ces préfixes.

Reçu :
`/tmp/cerp-metrology-2.0.27-gate/runtime-builder-cache-20261027/receipt.json`.
SHA-256 du log communiqué :
`6f479c27a7d3db83e6918f3509db4d22479747411dfa02ba6271d1633706eddc`.
Le pilote rapporte readiness HTTP 200 et version applicative inchangée avant et
après, ainsi que 33 065 316 352 octets libres sur disque. Ces constats proviennent
de son point ; ils ne sont pas un nouveau contrôle indépendant de ce registre.

Il s'agit d'un téléchargement du daemon Docker **hors cgroup RUN**, déclaré à
Notifications. L'ajout au cache ne doit pas être décrit comme une absence de
toute mutation du VPS, ni comme un build ou un déploiement de CERP. Aucun
build/test VPS, changement de service/base/route, feed ou partage Z n'est annoncé
par cette préparation ; aucun main fusionné. Le FULL candidate local v3 de la
même paire reste en cours et non qualifié selon le pilote.

## V3 Windows échouée / précheck backend v4 — 27 octobre, vers 02:42 Paris

Le rapport `20261027T012135Z-candidate-dba8ac47-15c5fc39` a été relu avec
`verdict=failed` : frontend-tests passed, backend-test-collection passed,
backend-tests failed. Le pilote atteste frontend complet 622 fichiers /
4 286 tests réussi. Il signale un parallélisme Vitest 3 trop élevé sur l'hôte 24 CPU,
atteinte de la limite Job 5 632 MiB et allocation V8 refusée ; pic annoncé
5 905 682 432 octets, OOM guest/cgroup à zéro, réserve Windows d'environ 9 Gio
ensuite. Aucun OOM global ni impact VPS annoncé. Ces observations ne constituent
pas une réussite backend ou du FULL, ni une panne de production établie.

Adaptation annoncée dans le seul lanceur v4 : `VITEST_MAX_FORKS` /
`VITEST_MAX_THREADS` à 2, minima à 1, sans changement de source candidate,
d'assertions ou skip. Une vérification indépendante en lecture seule des
variables reconnues et de leur propagation a été terminée, sans lancer de tests
concurrents. Le précheck backend complet est distinct d'un nouveau FULL canonique.

Correction de notre audit statique : le repli interne
`resolved.pool ??= 'threads'` avait été pris à tort pour le défaut effectif.
Le code installé, relu après signalement du pilote, définit déjà `pool: 'forks'`
dans `vitest/dist/config.cjs:91` et `chunks/defaults.B7q_naMc.js:83` ; ni la config
backend ni sa commande ne le surchargent. La stack du crash contient aussi
`ProcessWorker.send` / `child_process` selon le pilote. Les bornes actives sont
donc `VITEST_MAX_FORKS=2` / `VITEST_MIN_FORKS=1` ; les équivalents THREADS sont
également reconnus et bornés. Le code installé lit les deux jeux de variables
dans `node_modules/vitest/dist/chunks/coverage.DfSpMS-b.js`, lignes 3718–3761.
`backend-precheck-bootstrap.mjs` affecte les quatre variables avant de lancer
`pnpm test:run` avec `env: process.env`, après le nettoyage initial du lanceur.
Le bornage et sa propagation sont cohérents ; cet audit ne mesure pas tous les
workers futurs et ne présume pas le résultat du précheck.

Reçu lu sous l'audit :
`local-backend-precheck-2026-10-27T01-40-14-100Z/launch.receipt.json`, lancement
`01:40:14.139Z` (02:40:14 CET), controller PID `44916`, Job PID `48456`, même paire
complète `dba8ac4751b636d95fb4f00f62e518dab3012fec` /
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`. Préflight enregistré :
9 737 834 496 octets Windows disponibles et guest working set 5 965 152 256 octets.
Le controller porte limite commit `5905580032`, CPU rate `1666`, child assigné
au Job/PID `47728`. Le PID `48456` a été observé vivant sur le binaire figé v4.
Pas de résultat final attesté par ce seul reçu de démarrage.

Le SHA-256 recalculé de `local-runner-frozen-20261027-v4/SHA256SUMS` est
`cc784944f48dfbc5ef6c8c06f618a481ab906571c1126dc8c0ba9c9bd41fcd21`, conforme à
la référence du pilote. Les dix fichiers couverts correspondent : huit de la v3,
plus `backend-precheck-bootstrap.mjs` et `launch-backend-precheck.mjs`. Aucun
helper exécuté par cette lecture. Aucun merge main, déploiement applicatif,
migration, feed ou partage Z annoncé.

## Précheck v4 réussi / nouveau FULL v4 annoncé — 27 octobre, 02:45 Paris

Le pilote atteste le précheck backend v4 terminé vers 01:44 UTC (02:44 CET) :
824 fichiers / 8 643 tests réussis, avec **32 fichiers / 261 tests
conditionnellement ignorés déjà existants**, durée 234,41 secondes. Cela ne
signifie pas zéro test ignoré ; le résultat du précheck et les exceptions du
profil canonique doivent rester distingués. Aucun ajout de skip ou changement
d'assertion n'est annoncé.

Le controller a été relu : `JOB_PEAK_COMMIT_BYTES=1684811776`, `EXIT=0`, conformes
au point du pilote. Le bootstrap candidate v4 a aussi été relu : les quatre
variables MAX/MIN FORKS/THREADS portent bien 2/1. Cette lecture corrige notre
erreur de dénomination du pool, sans exiger de changement au réglage déjà choisi.

Un nouveau FULL canonique v4 est annoncé réellement démarré à 01:45:14 UTC
(02:45:14 CET), même paire exacte `dba8ac4751b636d95fb4f00f62e518dab3012fec` /
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`. Rapport
`20261027T014518Z-candidate-dba8ac47-15c5fc39`, reçu sous l'audit
`local-full-candidate-2026-10-27T01-45-14-344Z`. Le pilote rapporte douze phases
passées et frontend-tests en cours, pas un verdict global.

Les prochains retours de coordination sont regroupés au verdict complet ou à
un incident réel, à la demande du pilote. Aucun nouveau polling répétitif ni
test parallèle n'est entrepris par ce registre. Aucun merge main, déploiement
applicatif, migration, feed ou partage Z annoncé.

## Verdict FULL Windows v4 / préparation v6 — 27 octobre, point vers 03:56 Paris

Le rapport `20261027T014518Z-candidate-dba8ac47-15c5fc39` est relu **failed**, avec
vingt phases passed puis `e2e-isolated=failed`. Fin annoncée à 02:33:17 UTC
(03:33:17 CET). Le pilote rapporte frontend 4 286 / backend 8 643 tests,
builds et migrations verts, puis Playwright 346 pass / 13 fail / six skips
existants et contrôle d'accès 4/4. Aucun de ces résultats partiels ne qualifie
le FULL échoué.

Classification du pilote : dix échecs après mort de ViteStation sous la limite
Job 5,5 Gio, un Reporting bootstrap `ERR_NO_BUFFER_SPACE` puis `ERR_ABORTED`,
un catalogue fixture 404 lié au filtrage de la variable et aux noms sibling
non standards, un Planning revenu à Placement pendant scroll/screenshot dont
la cause reste non confirmée. Pic Job annoncé 5 914 042 368 octets, au-dessus
de 5 905 580 032 ; pas d'attribution métier déduite pour les cas non établis.

Archive sous l'audit `local-failed-v4-e2e`, avec `provenance.json` et
`canonical-report.json`. Vérification locale effectuée : les **996 entrées**,
pour **194 917 531 octets**, correspondent toutes au manifeste SHA-256
`80e3c04cfb0bf0fbb22d3d98d6e808bf9cedb6203496121f0bc2907dc8223a53`.
Cette vérification d'intégrité n'est pas une reproduction des échecs.

Préparation suivante : nouveaux clones réels `frontend` / `backend` sous
`C:/Users/KeenanMARTIN/Documents/Github/cerp-metrology-qualified-local-20261027`,
HEAD vérifiés égaux aux mêmes `dba8ac47…` / `15c5fc39…`. Aucun changement source
de fixture annoncé pour corriger la topologie. Le reçu v6 porte
`INERT_NOT_LAUNCHED`, sourcePairUnchanged true, Job 7 680 MiB, WSL 5 120 MiB,
cgroup Docker 3 072 MiB et total maximum 12,5 Gio : redistribution Job 7,5 / WSL 5
au lieu de 5,5 / 7, total inchangé, CPU Docker 4 annoncé inchangé.

Le fichier temporaire `.wslconfig` possédé porte le SHA-256
`db1f8e7e5421c9b5b4ef27ed4d68bfb9e81400478de65817278024226a0b1aa6`,
recalculé conforme. Le pilote indique que l'original était absent : son retour
à cet état devra être attesté au nettoyage local final, pas présumé accompli.
Il rapporte sept anciens conteneurs locaux always autodémarrés au boot remis
off, données/policies inchangées, trois unless-stopped non modifiés, et moteur
Desktop Linux MemTotal 5 157 130 240 octets / huit CPU. Ce ne sont pas des
modifications des services de production VPS.

Canari Job capture/accounting annoncé passed à 8 053 063 680 octets. Preuve RUN
v6 relue sous `local-runner/local-root-build-proof-v6.json` : passed à
`02:50:03.637Z`, legacy, contexte git archive exercé/nettoyé et build exit 0,
PID `2837` sous le parent `/cerp-metrology-gate-20261027-local`. Le manifeste
`local-runner-frozen-20261027-v6/SHA256SUMS`, SHA-256
`5ddbd7bd8291f5d74e25f5a3c53e097f24a5bbe9f5b0ec7418b927a6668ac22a`,
et ses douze fichiers ont été vérifiés conformes par recalcul. Il ajoute les
bootstraps/lanceurs focused E2E aux fichiers précédents.

Le reçu exige canari Job, preuve RUN sur le guest 5 Gio, retour off des sept
conteneurs et reprise ciblée des ressources/classes connues avant un FULL
canonique. Le pilote annonce les dépendances des nouveaux clones en cours et
aucune recette v6 encore lancée à ce point. Aucun merge main, déploiement
applicatif, migration, feed ou partage Z attesté.

## Relecture indépendante Planning de l'archive v4

Revue en lecture seule, sans test, navigateur ou patch :
`e2e/planning-central-coverage.spec.ts:87` expire après dix secondes au clic du
lien « Réserver la matière et préparer les manques ». Les assertions Dossier,
Couverture, quantités/risque/date et href `/production/of/42?tab=approvisionnement`
avaient réussi avant scroll/screenshot. Trace : clic Dossier fini à 873488 ms,
screenshot 873558–873747, clic du lien à 873749 puis expiration à 883762.
La capture d'échec montre réellement Placement sélectionné et Dossier absent.

De nouveaux GET couverture/fenêtre planning surviennent pendant la capture,
puis un access-profile pendant l'attente. C'est une corrélation, pas une cause
prouvée. `OperationInspector.tsx:61` initialise la section à schedule et la
modifie via Tabs ; `CentralPlanningWorkspace.tsx:454` utilise une clé
`focused.id + ':' + simulation.id`. Aucune simulation dans ce scénario ; un
refetch seul ne prouve pas un remount ni la raison du retour d'onglet.

L'évidence confirme une instabilité visible dans ce parcours E2E, sans établir
une cause scroll/screenshot ni une reproduction utilisateur hors E2E. Prochaine
preuve proposée au pilote : reprise isolée avec vérification `aria-selected`
après capture et instrumentation du montage/refetch de l'inspecteur. Aucun
patch UI aveugle ni contournement par nouvelle sélection d'onglet n'est validé
par cette revue.

## Nouvelle paire / runner Docker Linux local — 27 octobre, point reçu vers 05:00 Paris

Frontend courant annoncé par le pilote :
`2d5442b17e0482bd69b3221f5a5c6a3c66586d0f`, backend inchangé
`15c5fc3951756fb7245e3a0111678b8cdf7fd8be`. Le compare GitHub depuis `dba8ac47…`
a été relu : un commit, `docs/release/DESKTOP-2.0.27.md` et deux specs E2E
seulement. Dans `admin-dashboard-1667.spec.ts` et `atelier-station.spec.ts`,
`page.goto` reçoit `timeout: 40_000` et un commentaire pour la navigation à froid.
Assertions et code applicatif inchangés ; cela ne vaut pas réussite de ces
scénarios ni transfert du verdict d'une ancienne paire.

Les échecs mémoire Job Windows ont motivé, selon le pilote, le déplacement de la
qualification vers un runner Docker Linux **local** borné : VM 7 Gio, groupe
5 Gio, swap 8 Gio et CPU 4 annoncés. Ce sont les paramètres du nouveau runner ;
les répartitions Windows/WSL précédentes restent historiques. Le nouveau reçu
d'exécution, ses preuves de portée et le verdict physique complet sont attendus
au prochain jalon significatif, sans polling ou test parallèle de ce registre.
La restauration locale finale des configurations temporaires reste à attester.

Notifications a vérifié indépendamment la conservation sur cette paire : watcher
SHA-256 des sources normalisées LF
`a1ae84cd8f8994fe84c24afaa26fabcf0f7afbbbdc87a0a9c9a1ba2c711e15cc`,
module `realtime-control-plane.ts` normalisé LF
`e52af7cf57040a6c93bef4a8800f64eead528563ba60751328c32586e3c325ea`,
identiques aux correctifs validés. Ces empreintes de sources normalisées sont
distinctes du domaine des hashes d'octets installés consignés auparavant ; ne
pas les confondre. Sa relecture du compare confirme le même périmètre de trois
fichiers. Aucun nouveau contrôle de santé serveur n'est déduit de ces vérifications.

Candidate complète toujours non qualifiée, sans fusion main, mutation
production/SQL, feed ou partage Z annoncés. Lots entreprise et cutover toujours
exclus de `2.0.27`, pilote unique inchangé. Le point Planning de l'archive v4
n'est pas clôturé par le seul ajustement des délais d'autres fixtures ; sa
reprise et le verdict complet restent à documenter.

## Candidate complète PASSED puis fusion main — 27 octobre, vérifications vers 05:53 Paris

Rapport physique relu :
`frontend/outputs/release-gate/20261027T040645Z-candidate-2d5442b1-15c5fc39/report.json`
dans le clone canonique. Target `candidate`, verdict `passed`, 22 étapes passed,
début `04:06:45.610Z`, fin `04:45:34.544Z` (05:45:34 CET). SHA-256 recalculé
conforme : `8829e7c3cbdf695a96ad7ccb5bd95290e04bb6c19f6784f7c9d311d4c85dda6a`.
Notifications a aussi relu indépendamment ce rapport et son empreinte, sans
prétendre avoir refait tous les hashes d'artefacts.

Les comptes relus dans les logs/provenances par notre revue indépendante sont
4 286 tests frontend, 8 643 backend (avec 261 skipped conditionnels déjà
consignés), Playwright 359 passed / six skipped préexistants / zéro unexpected ou
flaky, accès 4/4. Le pilote atteste zéro échec/retry. Runtime structuré :
6 144 événements, status passed et liste bloquante vide. Répétition de migration,
rollback test-only et restauration vers une base neuve passed ; empreintes
source/restaurée identiques, restore passed et replay true. Ce sont les preuves
de recette isolée, pas des migrations sur les bases réelles.

Manifeste physique `integrity-manifest.json`, SHA-256
`2c8cbcdb4f6141a25b56de951b5cb0394d48f2e8c5e0cc41b0bbd73810bed59c`,
conforme au sidecar et au reçu d'export. **Les 4 561 fichiers, totalisant
220 401 642 octets, ont été rehachés localement en lecture seule : tous
correspondent en longueur et SHA-256.** La précision d'inventaire du pilote
distingue cinq groupes déployables (frontend-dist, backend-dist,
backend-db-patches, backend-resources, backend-runtime-source) et trois ensembles
de preuves (e2e, logs, migrations). Cela correspond bien aux huit groupes/préfixes
du générateur et du manifeste ; l'annonce « cinq » visait les déployables, pas
un autre nombre de fichiers. Aucun fichier manifest manquant ;
les cinq métadonnées hors inventaire sont report JSON/MD, receipt, manifest et
sidecar attendus.

Raw E2E sous l'audit `linux-candidate-passed-20261027` : manifeste SHA-256
`948749bfa6d0449e4c5ca22719bc16f31652ef34781dc1361a8f4381869bb2ff`,
923 entrées et 923 fichiers physiques hors manifeste, contrôlés par l'agent de
revue. Son rehash raw borné de quatre fichiers correspond ; ne pas le présenter
comme un second rehash intégral des 923. Les paths raw sont relatifs et le reçu
d'export relie le dossier Linux au dossier Windows présent. Le pilote atteste
parent local max/OOM à zéro et VM OOM à zéro. Aucun test ou helper n'a été lancé
par les contre-vérifications de ce registre.

Fusion des PR vérifiée dans GitHub, après la fin passed : backend #1455 à
`04:48:48Z` vers `main` commit
`f796d2e504f2d60417778524ead41ca9a0f596eb`, frontend #1777 à `04:49:00Z`
vers `main` commit `d743bd48fa70de36b200e986043c2498085bd399`.
Compare candidat → main : un commit supplémentaire et zéro fichier différent
dans chacun des dépôts. Arbres Git identiques vérifiés : frontend
`a328ce35c9356ad7d996a103fbc580c2542c5320`, backend
`343cab7bb371502c2e70c58d9668d47469c1d287`. Notifications confirme également la
préservation des correctifs watcher/temps réel sur ces mains.

La qualification **candidate** est donc acquise pour cette paire et ses
artefacts. Le transport Git physique des mains puis la qualification production
complète restent à attester par le pilote, entièrement en local. Une identité
d'arbre ne remplace pas le gate target production. Aucun service/base/feed/Z
modifié ni déploiement applicatif annoncé. Le manifeste de migration réelle
sélective, les sauvegardes et contrôles frais restent ceux de la fenêtre future ;
les tests isolés ne donnent pas autorisation d'un `up` global. Lots entreprise,
B2C, cutover et bridge restent exclus. Opérateur unique inchangé.

## Qualification production locale poursuivie / préparation de fenêtre — 27 octobre, vers 06:22 Paris

Le pilote indique que la qualification production locale est toujours en cours
sur les mains exactes `d743bd48fa70de36b200e986043c2498085bd399` /
`f796d2e504f2d60417778524ead41ca9a0f596eb`. Il a repris l'observation directe
après un timeout du moniteur Windows, **sans relancer la recette ni changer les
tests**. Un timeout d'observation n'est donc pas enregistré comme une nouvelle
exécution ou un échec de test.

Lecture de l'état durable : la section `productionQualification` porte RUNNING,
avec `updatedUtc=2026-10-27T04:54:14.947Z`. Les anciens champs globaux/historiques
ne remplacent pas cette section dédiée et les preuves physiques du run. Aucun
rapport production final exported/passed n'est attesté par ce point.

Le pilote prépare les baselines en lecture seule et les sauvegardes HYPERBOX2 :
service canonique de sauvegarde complète et trois dumps PostgreSQL 17. Ce point
ne fournit pas encore de reçus de sauvegardes achevées ni de validation de leur
restaurabilité ; ils restent à joindre au dossier de fenêtre. Les cibles des
trois dumps ne sont pas inventées à partir de leur seul nombre.

Engagement du pilote inchangé : aucune migration, bascule API/UI/worker,
modification du watcher, publication de feed ou partage Z avant verdict
production physique PASSED. Il demeure l'opérateur unique ; ce registre ne lance
aucune sauvegarde ou opération serveur. Lots EC/B2C/entreprise/cutover exclus.
La classification « cinq déployables + trois preuves » est reprise ci-dessus,
sans modification du compte de 4 561 fichiers ni du résultat d'intégrité.

## Qualification production locale PASSED / préparation de livraison — 27 octobre, vers 06:39 Paris

Rapport physique relu dans le clone canonique :
`frontend/outputs/release-gate/20261027T045222Z-production-d743bd48-f796d2e5/report.json`.
Target **production**, verdict **passed**, 22 étapes passed, SHA main exacts
`d743bd48fa70de36b200e986043c2498085bd399` /
`f796d2e504f2d60417778524ead41ca9a0f596eb`. Début `04:52:22.934Z`, fin
`05:31:11.265Z` (06:31:11 CET). SHA-256 du rapport vérifié :
`c2aa605fffd88f7109e4bdf04b6b8828b78f139797bafa1522f0c8116e5c38e6`.

Manifeste vérifié :
`219fdc94fcebfd13986653dd81d9b1cfaa7e704ad4dd1002993ae0c7c8de0ed4`.
Les **4 561 fichiers / 220 824 617 octets ont tous été rehachés localement** :
longueurs et SHA-256 conformes. Le reçu `linux-export.receipt.json`, état
EXPORTED_AND_VERIFIED, daté `05:33:10.939Z`, confirme la paire main, le compte et
les empreintes du rapport/manifeste. Ce paquet est distinct du paquet candidate.

Le reçu contrôleur sous l'audit
`linux-qualification-20261027045222/receipt.json` porte GATE_COMPLETED/passed,
completed `05:31:21.545Z`, attestation `05:33:11.046Z`. Son historique de
supervision et ses instantanés ne remplacent pas les 22 étapes du rapport final.
Le pilote confirme l'exec Docker original `a972d325…` terminé exit 0 : même
recette poursuivie après l'échec du moniteur Windows, sans retry, modification
de source ou phase sautée annoncés. Aucune relance n'est inventée depuis le
timeout d'observation.

La revue indépendante des reçus de préparation ne relève pas de contradiction
bloquante :

- `predeployment-backups-20261027052332/receipt.json` : commande backup exit 0,
  terminée `05:25:02.774Z`.
- `canonical-recovery-verified.json` dans ce dossier : état
  FRESH_CANONICAL_RECOVERY_RECEIPT_VERIFIED, contrôle daté `05:29:20Z`, snapshot
  140 068 037 octets, intégrité et capacité passed selon le reçu lu.
- `pg17-dumps-verified.json` : FRESH_THREE_PG17_DUMPS_AND_CATALOGS_REHASHED,
  `05:29:21Z`, trois cibles `cerp_test`, `cerp_test_template_204_139385585b8a` et
  `cerp_prod`, tailles/hashes dump et catalogue présents. Les dumps réels sous
  `/var/backups/cerp/...` n'ont pas été ouverts par cette revue ; la vérification
  distante est attestée par ces reçus, pas exécutée à nouveau par ce registre.
- `linux-production-transport/main-d743bd48-f796d2e5/transport-manifest.json`
  et reçu associé : bundles main vérifiés, `changedPaths: []`, même paire. Ce
  transport Git local est distinct du transport de livraison vers les services.

Plan `md15-promote/promotion-md15-2.0.27.template.json` et README inchangés sur le
point essentiel : seul patch MD15 hash LF `814333d4521a11239a4f70745ff6ff2e4cebb506617b4645cd4c9147cfe0ef1d`,
runner géré, ordre test → template → production avec un reçu pour chaque cible.
`onlyThisPatch: true` et suivi #1458 séparé. Ni template préparé ni backup ne
constituent un reçu de migration réelle ; aucun plan final rempli/apply n'est
attesté par cette revue.

Le pilote ouvre la préparation de fenêtre : transport des octets attestés et
fabrication de l'installateur. Il annonce les baselines à `05:23Z` (06:23 CET) :
API publique/native ready, route/Apache inchangés et watcher `f553d53d…` préservé.
Ces mesures sont datées et rapportées, pas un nouveau relevé serveur de ce chat.
Verdict après bascule/feed/Z encore attendu. Aucune application, migration réelle
ou publication n'est attestée ici ; le pilote demeure seul opérateur, les lots
EC/B2C/entreprise/cutover restent exclus.

## Images/installateur préparés / passage à MD15 annoncé — 27 octobre, baseline 06:55 Paris

Le pilote rapporte les images serveur attestées construites/vérifiées et
l'installateur fabriqué/vérifié, après la qualification production exportée.
Ce point ne fournit pas encore leurs identifiants complets ni reçus de
publication : la fabrication ne doit pas être présentée comme une installation
ou mise à disposition sur le feed/Z.

Nouvelle baseline annoncée à `05:55Z` (06:55 CET) saine, sans bascule ni SQL à
ce relevé. Le pilote passe à la phase **MD15 seule**, test → template → production,
avec sauvegardes et reçus réels, puis prévoit bascule native/API/UI/worker et
publication feed/Z. Ces étapes restent des opérations à attester par leurs
propres reçus ; une intention de lancement ne vaut pas migration déjà appliquée.

Le patch, les gardes sélectifs et le suivi #1458 restent inchangés. Aucun lot
entreprise/EC/B2C/cutover dans cette livraison. Le pilote demeure l'opérateur
unique ; aucune mutation parallèle n'est entreprise par ce registre.

## Conservation vérifiée et état d'exploitation daté

Le chat Notifications a comparé les fichiers de la candidate Métrologie avec
ses correctifs : le module temps réel est identique après normalisation des fins
de ligne ; le watcher est identique. Les commits de conservation Métrologie sont
`473c6a68` côté backend et `818f965a` + `3e20789a` côté frontend.
SHA-256 du watcher installé et conservé :
`f553d53d5ec03de7a4485e6287a10cf74b09859b6e6afe2fac692180fc739936`.

Le relevé Notifications indique 18 contrôles VPS et 23 HYPERBOX2 sains, les
timers actifs, outboxes vides et les cinq dépendances requises disponibles. Les
API de production ont leurs workers désactivés ; le worker dédié est leader
avec 12 tâches. Ce sont des observations datées, à refaire à la bascule.

La version publique stable relevée est
`d176c68e0408f0aac83fa6f4d01260174c0594b3-rt1450-f15d7738`, image
`sha256:3c37e1996995b6ed6b3dfc8086a02822f41453fdc349e2a9052d57e6e1eaf993`.
La candidate Métrologie ne doit pas être présentée comme cette version stable.
La validation locale multi-entreprises ne donne aucun constat de santé serveur.

## Séquence retenue pour `2.0.27`

1. Terminer le gate complet de la candidate ; les rapports interrompus/échoués
   restent conservés et ne deviennent pas des validations.
2. Fusionner uniquement les commits qualifiés dans `main`, enregistrer les SHAs
   finaux, puis exécuter le gate de production complet sur ces SHAs.
3. Construire les artefacts web, API et Windows à partir des mêmes sources
   attestées, avec numéro de version et manifeste cohérents.
4. Refaire préflight, sauvegardes et contrôles readiness pour la fenêtre annoncée.
5. Appliquer uniquement la migration MD15 explicitement sélectionnée, avec
   sauvegardes/reçus : test → template → production, puis vérifications.
6. Basculer les composants prévus : API VPS, API test/prod et worker Hyper,
   web public/local. Conserver l'API sans workers, le worker leader, les volumes
   privés, les readiness DB/GED/médias/antivirus/temps réel et l'antivirus enforce.
   Ne pas relancer les API retirées du routage. Préserver les anciens assets/UI
   nécessaires aux pages déjà ouvertes.
7. Le chat Notifications refait ses contrôles après la bascule. Publier les
   payloads et blockmaps avant `latest.yml`, puis vérifier le feed et les octets.
8. Pour le partage d'installation : utiliser le script canonique en dry-run,
   puis `cerp-installation-tools/publish-installation.mjs --source <livraison-validée> --apply`.
   Un seul `CERP-Setup-<version>.exe` dans `Z:\CERP-INSTALLATION\01-Windows`,
   avec son éventuel `.blockmap` et `latest.yml` cohérent. Aucun installateur ou
   `latest.yml` à la racine, aucune archive des anciennes versions ; la nouvelle
   copie est vérifiée avant retrait de l'ancienne. Android garde son manifeste
   et sa version propres ; applications spécialisées, pilotes Brother et guides
   sont conservés.

Migration unique annoncée par le pilote pour ce lot :
`db/patches/20261026_metrology_md15_profile_codes.sql`, SHA-256 canonique LF
`814333d4521a11239a4f70745ff6ff2e4cebb506617b4645cd4c9147cfe0ef1d`
(recalculé localement). Aucun autre patch pending n'est appliqué implicitement.
En particulier, le catalogue/provenance Outillage n'est pas un ordre d'exécution
supplémentaire déduit d'un diff de branches : le manifeste et le ledger réels
doivent déterminer tout besoin distinct.

Le pilote conserve son état durable dans le fichier local
`MD15-RELEASE-STATE.json`, dossier temporaire
`cerp-metrology-deploy-audit-20261026`. L'état initial
`candidate_r5_running` / `running_not_qualified` est historique. L'état final
est `DEPLOYED_AND_DISTRIBUTED_2_0_27_VERIFIED`, avec les reçus de clôture
rapprochés ci-dessous.

## Livraison ultérieure multi-entreprises : dépendances explicites

Elle ne sera pas intégrée par une fusion globale de branches pendant la recette
MD15. Repartir de la base finalement qualifiée/publiée, résoudre les changements
communs (auth/login, clients, navigation, commandes, serveur Directory, routage,
startup/workers), conserver les corrections Métrologie et Notifications, puis
régénérer OpenAPI et refaire la qualification d'intégration. Pas de résolution
globale « prendre notre fichier » sur ces frontières.

Ordre requis pour B2C : patch additif `client_person_types_1454` sur chaque base
métier visée → backend B2C validé → frontend/web/desktop proposant Particulier.
L'ancien backend peut éliminer les champs inconnus et créer silencieusement un
professionnel ; le nouveau backend écrit les nouvelles colonnes. Le flag
multi-entreprises désactivé ne remplace donc pas cette migration.

Pour activer de nouvelles entreprises seulement :

1. Registre privé `db/shared-directory/20261026_business_companies_1454.*`
   dans la Directory, avec ses scripts propres, hors runner métier.
2. Schéma qualifié des bases opaques, puis fondation explicite
   `db/company-sites/20261026_company_directory_sites_1454.*` ; elle ne crée pas
   de base ni n'importe d'utilisateurs/secrets. L'ancien patch de sites Directory
   ne doit pas être lancé sur une base opaque.
3. `company_policy_projections_1454` sur chaque base métier qui utilisera ce mode,
   après ses prérequis d'identité et d'access-control ; préflight et verify.
4. Routage fixe, racines/volumes et secrets propres aux instances, memberships
   réels sélectionnés explicitement et modules accordés ; qualification des
   clients HTTP/Socket et des chemins natifs/PIN avant activation.
5. Activer le runtime seulement avec son binding fixe et workers explicitement
   `off` ou `leader`, après recette à deux bases/services et reprise/restore.

Les rollbacks SQL sont gardés : B2C refuse après présence d'un particulier,
policy après une projection et registre après données/audit/memberships de site.
La fondation opaque refuse après des projections et conserve ses colonnes
additives lors d'un rollback vide. Ne pas considérer un downgrade d'images ou un
drop SQL comme une restauration qualifiée de données déjà créées.

La connexion legacy propre tolère le bootstrap 404 ; une session ayant déjà une
portée entreprise échoue fermée si l'ancien backend ne connaît plus cette portée.
Le scénario de retour arrière doit traiter cette reconnexion explicitement.
L'installateur de cette future livraison prendra une nouvelle version à partir
de la dernière version réellement publiée, sans réserver ni écraser `2.0.27`.

## Preuves et clôture

Preuves multi-entreprises : [qualification locale](multi-company-runtime-1454.md).
Les trois chats conservent leurs issues et rapports propres ; les PR ouvertes,
les suivis #1456/#1458 et le bridge restant ne sont pas clôturés par cet accord.
Les SHAs publiés, reçus de migration, version d'installateur et résultats après
bascule du lot Métrologie sont rapprochés ci-dessous. La clôture de cette
livraison ne clôture aucun travail multi-entreprises restant.

## Clôture du lot Métrologie — 27 octobre 2026, après 07:22 CET

La livraison `2.0.27` est effective. Le pilote unique a publié le frontend
`d743bd48fa70de36b200e986043c2498085bd399` et le backend
`f796d2e504f2d60417778524ead41ca9a0f596eb`. Leurs arbres sont identiques à
ceux de la candidate qualifiée, comme vérifié avant le gate production. Le
présent chantier n'a exécuté ni migration, ni bascule, ni publication.

Sources locales de preuve du pilote, sous
`C:\Users\KeenanMARTIN\AppData\Local\Temp\cerp-metrology-deploy-audit-20261026` :

- `DELIVERY-FINAL.receipt.json` :
  `DEPLOYED_AND_DISTRIBUTED_2_0_27_VERIFIED` ;
- `MD15-RELEASE-STATE.json`, mis à jour à `06:21:55.928Z` : même état,
  bloc `deployment` avec migration, déploiement, Hyper, VPS, feed et Z à `true` ;
- `real-md15-all-scopes-completed-plan.json` : reçus réels des trois bases ;
- `hyper-post-deployment-readonly.json`,
  `native-effective-vhost-publication.json`,
  `vps-final-promotion-application.log`, `desktop-feed-publication.log` et
  `z-distribution-final.receipt.json` : publications et contrôles correspondants.

Les anciens champs racine `productionApplicationDeployment: false` et
`productionDatabaseMigrationApplied: false` restent des observations historiques
de recette dans le fichier d'état. Le pilote l'a confirmé explicitement :
l'état final, le bloc `deployment` et le reçu `DELIVERY-FINAL` sont les références
de la livraison réelle. Les lire comme l'état courant contredirait les reçus.

### Qualification et migration effectivement livrées

Le gate production local
`20261027T045222Z-production-d743bd48-f796d2e5` est PASSED : 22 étapes,
4 286 tests frontend et 8 643 backend réussis, puis 359 tests UI/Electron réussis,
6 ignorés préexistants, aucun résultat inattendu ni flaky, accès 4/4.
Les 261 exclusions conditionnelles backend préexistantes restent déclarées.
La restauration, le rollback et le replay ont réussi. Le registreur a rehashé
les **4 561 fichiers / 220 824 617 octets** du manifeste exporté : aucune divergence.
SHA-256 du rapport :
`c2aa605fffd88f7109e4bdf04b6b8828b78f139797bafa1522f0c8116e5c38e6` ;
du manifeste :
`219fdc94fcebfd13986653dd81d9b1cfaa7e704ad4dd1002993ae0c7c8de0ed4`.
Le timeout de l'observateur Windows n'a pas relancé la qualification : le
processus Docker d'origine est sorti avec code 0 et reçu final PASSED.

Les sauvegardes fraîches et leurs reçus d'intégrité/capacité ont précédé la
migration ; les trois dumps PostgreSQL 17 ont été vérifiés par le pilote sans
ouverture de leur contenu par ce chantier. Le seul patch appliqué réellement
est `20261026_metrology_md15_profile_codes.sql`, SHA-256 canonique LF
`814333d4521a11239a4f70745ff6ff2e4cebb506617b4645cd4c9147cfe0ef1d`,
avec `up --only` et le même backend qualifié. Reçus UTC :

| Base | Reçu | Contrôle |
|---|---|---|
| `cerp_test` | `06:04:39Z` | Vérifié, ledger exact, ACL/réservations et immuabilité contrôlées. |
| `cerp_test_template_204_139385585b8a` | `06:04:40Z` | Idem ; template volontairement sans catégories, structure validée. |
| `cerp_prod` | `06:04:41Z` | Idem ; 11 catégories actives, dont les 6 requises, comme en test. |

Ni `up` global, ni réconciliation #1458, ni import historique Excel, ni seed
ponctuel #1456. Aucun patch Directory, B2C ou multi-entreprises appliqué.

### Services, interface et conservation des correctifs

Les reçus attestent API test/prod et worker Hyper, interface native, API/UI VPS
et interface publique sur le couple publié. Le worker prod est leader avec
12 tâches ; les API conservent leur mode sans workers. Les dépendances requises
DB/GED/médias/antivirus/temps réel sont up. Les volumes privés, aliases et
paramètres effectifs ont été préservés. Les contrôles de compatibilité ont
vérifié 47 anciennes routes d'assets côté VPS ; côté natif, 426 anciens assets
sont préservés et 9 échantillons HTTP ont été vérifiés.

Ports réconciliés avec le pilote : UI native Apache **8081** (`cerp-local.conf`,
`cerp.local`) → proxy `/api/` Apache API **8080** → slot green **18081**.
API test **8082**, worker **18082**. La santé directe 18081 et le HTML 8081
correspondent à deux services distincts. Les fichiers Apache available/enabled,
copies régulières distinctes, ont été réconciliés depuis la configuration
effective, avec sauvegarde, configtest, reload et rollback conservé.
Le HTML 8081 a été vérifié indépendamment par Notifications : HTTP 200,
625 octets, SHA-256 exact du renderer qualifié
`3d7254192f8bee2b6fee10876ad81251f24adea991f056dab677a03a8516c2d7`.

Le contrôle indépendant Notifications de **07:21:59 CET / 06:21:59 UTC** a relevé
42 contrôles sains (19 VPS, 23 Hyper), timers actifs, états récents et outboxes
vides, sans incident actif constaté. API/UI routées healthy, restart 0,
OOMKill false. Le watcher installé reste
`f553d53d5ec03de7a4485e6287a10cf74b09859b6e6afe2fac692180fc739936`.
Le JS temps réel des vrais points d'entrée test/green/worker et VPS correspond
au fichier qualifié :
`cd115f108edb1a5a24ff768476272bc785b4fdba4d1d87f35fb25e0eed05d913`.
Aucun seuil existant, activation email ou limite existante n'a changé ; seule
l'entrée de la nouvelle UI VPS ajoute mémoire 512 MiB / CPU 1 / PID 256.
Preuves publiées dans la PR frontend #1772, commit documentaire
`73cc310bb629c4620d59d81052238b33beadad2d`,
`docs/testing/supervision-1771-20261026.md`.

Deux exceptions transitoires restent dans les preuves, sans conclusion causale
inventée :

- Deux timeouts PostgreSQL à 07:09:13.893 et 07:09:16.497 CET concernent la
  purge de présence chat `sweepExpired`, clé `9223372036854775806`, avec trois
  logs de convergence associés. Aucun détenteur/attente au contrôle ni récidive
  jusqu'à 07:21:22. Cette contention de transition est distincte de l'allocateur
  corrigé ; sa cause précise reste inconnue. Aucun nouveau 503, échec de polling
  ou perte de leadership relevé dans ce contrôle.
- Les deux mails vers 07:18 et 07:20 correspondent à un incident de sonde Docker
  `container_query_failed` puis son rétablissement après trois cycles sur
  l'ancienne UI `doc222`. Ce conteneur reste celui du 23 octobre, restart 0,
  OOMKill false et actuellement healthy. Aucun arrêt applicatif n'est prouvé ;
  la cause exacte de l'échec de requête Docker n'est pas enregistrée. Aucune
  alerte n'a été masquée.

La clôture du lot de livraison ne clôt pas l'analyse causale de ces observations.

### Windows, feed et partage d'installation

Le pilote atteste publication des payloads et blockmaps avant manifestes puis
`latest.yml`, et contrôle HTTPS des empreintes sous
`https://erp-backend.croix-rousse-precision.fr/desktop-updates/win`.
Le script canonique de distribution Z a été exécuté en dry-run puis `--apply` ;
la nouvelle copie a été vérifiée avant suppression de `2.0.26`.

Le registreur a vérifié indépendamment en lecture seule le partage
`Z:\CERP-INSTALLATION\01-Windows` : un seul EXE `CERP-Setup-2.0.27.exe`
(177 986 158 octets), sa blockmap (187 360 octets) et `latest.yml` cohérent
(340 octets). La recherche récursive ne trouve qu'un installateur CERP dans
le partage ; aucun installateur/`latest.yml` interdit à la racine. Le YAML
désigne le bon nom, la bonne taille et la version `2.0.27` ; son releaseDate
est `2026-10-27T05:51:06.915Z`.

L'EXE Z a été entièrement relu et haché sans exécution, taille/date stables
pendant la lecture. SHA-256 :
`e31f2c290fb8334a9959f3510c68409c8810ceb9bea18ab10294db7978b46087`.
SHA-512 base64, identique aux deux champs du YAML :
`Na3TkWzIbiWjBwO6dUNEFlKVxBCDAzkl75t8xFunAAg2aig6IOovAUfk79Hi7UiHDUavn3nMLYNwuHQxS8xklQ==`.
Android reste sur sa version indépendante `2.0.13` selon le reçu du pilote ;
applications spécialisées, pilotes et guides restent conservés. Aucun
installateur n'a été exécuté par le registreur.

Contre-vérification déléguée en lecture seule à **07:46:16 CET** : le
`latest.yml` HTTPS et celui de Z ont les mêmes 340 octets et le même SHA-256
`3ac69bf55e9602aa642594a8225d4df7a57836c17e25919b8602d9623070d707` ;
les blockmaps ont les mêmes 187 360 octets et le même SHA-256
`163aa86e30fde22ecf92b0b13f5a4eb64735a91ee38d562219ff3874d6c2def2`.
Le HEAD HTTPS de l'EXE répond 200 et Content-Length 177 986 158, égal à Z.
Cette vérification n'a pas téléchargé le payload HTTPS complet : son hash
public reste attesté par le reçu du pilote, distinct de la relecture complète
du fichier Z par le registreur. Le manifeste
`Z:\CERP-INSTALLATION\02-Tablette-Android\latest.json` désigne bien
`CERP-Tablette-2.0.13.apk`, versionName `2.0.13`, versionCode `20013` ; aucun
hash APK n'a été recalculé.

### Nettoyage local et lots encore ouverts

Le reçu de nettoyage local est COMPLETED : ressources de qualification Docker,
volumes et cgroup supprimés, Docker Desktop arrêté et WSL vide selon le pilote.
L'absence initiale de `C:\Users\KeenanMARTIN\.wslconfig` est rétablie et vérifiée
directement par le registreur. Aucun nettoyage supplémentaire de données ou
conteneurs utilisateur n'a été entrepris par ce chantier.

**Seul le lot de livraison Métrologie `2.0.27` est clôturé ici.** Les suivis
#1456 et #1458, les PR de traçabilité et les issues multi-entreprises #1454/#1775
conservent leur portée propre. Socle entreprise, B2C, création/import du
catalogue CRP et tarifs par variante, achat EC → demande/acceptation CRP,
stocks/expéditions/documents EC et double facturation restent à intégrer et
qualifier. Aucun accès réel des sept utilisateurs demandés ni aucune base EC
n'a été provisionné. La boutique finale reste ultérieure.

La future intégration partira du couple main publié ci-dessus et conservera
Métrologie/Notifications ; elle exige ses migrations, sa recette à deux bases
et services, ses preuves de restauration et une nouvelle version Windows.
Cette clôture n'autorise aucune mise en service implicite du chantier EC.

## Suite locale EC — intégration sur les sources publiées du 27 octobre

Le socle est réintégré sélectivement sur les mains publiées, sans dev/cutover :
backend `feature/1454-company-main-2.0.27` (`b599449e`) et frontend
`feature/1775-company-main-2.0.27` (`e89dcb09`). La relecture a aussi produit
un correctif local du scope entreprise pour PIN/appairage/MFA. Tests ciblés,
typechecks et builds locaux réussis après correction ; preuve et limites dans
[le rapport d'intégration](multi-company-main-integration-1454.md).
Ces branches restent locales, non activées, sans nouveau déploiement. Elles
ne complètent pas encore le catalogue/bridge ni la logistique/facturation EC.

## 27 octobre — hotfix 2.0.28 et poursuite EC

L'opérateur du chat « Corriger la fenêtre des nuances et l » a terminé et libéré
sa fenêtre prioritaire 2.0.28 : web atelier/public et installateur Windows selon
son reçu `cerp-urgent-material-20261027/.hotfix/delivery-status.json`. Backend et
bases inchangés dans ce lot. Le commit frontend publié `22ba11e3` est conservé
dans la branche EC par cherry-pick `a80b160e`. La prochaine version à publier
devra tenir compte du 2.0.28 déjà distribué ; aucune régression vers 2.0.27.

Le chantier EC reste local. Les preuves natives et leurs limites sont suivies
dans [la qualification du flux](intercompany-native-qualification-1454.md), qui
remplace l'ancien état phase 1 pour l'avancement de ce flux. Il n'autorise ni
activation, ni modification implicite d'une base de production.
