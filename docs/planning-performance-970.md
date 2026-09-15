# Performance du planning — P10 / #970

Objectif : 50 ressources, 10 000 opérations et 20 utilisateurs simultanés. Les
budgets p95 sont de 3 s pour un planning utilisable, 1 s pour l'enregistrement
après confirmation, 10 s pour la simulation globale et 2 s pour le calcul local
des conséquences. L'attente humaine entre proposition et confirmation ne fait
pas partie du temps d'enregistrement ; le banc conserve aussi la durée complète
du parcours et les conflits de révision.

## Contrats

`GET /planning/v2/snapshot` accepte `placement=placed|backlog|all`,
`include_coverage=false` et `snapshot_revision`. Une opération sans engagement
reste dans la file, même si elle possède une prévision hors de la période.
La couverture matière reste disponible à la demande dans le dossier de l'OF.

Sans couverture, les pages utilisent un instantané immuable de 30 secondes,
limité à 10 000 opérations par fenêtre, 40 000 opérations et 16 entrées en mémoire.
Les chargements identiques simultanés sont regroupés ; quatre fenêtres distinctes
peuvent être préparées simultanément. Un pic peut attendre jusqu'à une seconde,
avec au plus 16 lectures en attente. `nextCursor` est opaque et doit être repris
tel quel, avec les mêmes filtres et la révision retournée. Un changement concurrent
permet de terminer la lecture ancienne avec `stale=true`. Une expiration ou
éviction renvoie `409 PLANNING_SNAPSHOT_EXPIRED` : reprendre à la première page.
Les commandes n'utilisent jamais ce cache de lecture.

`POST /planning/v2/preview` exige le droit `manage_schedule` et l'activation
`SIMULATE` ou supérieure. Corps : `from`, `to`, `revision`, `earliestStart`,
`autoAssign` et éventuellement `search` / `resource_id`. La fenêtre est limitée
à 367 jours et 10 000 opérations, dépendances comprises. La réponse contient
`readOnly`, `revision`, `stale`, `examined`, `requested`, `result` et les libellés
des opérations. Elle ne crée aucun engagement ni enregistrement de simulation.
Le filtre limite les propositions ; les réservations concurrentes de la période
restent prises en compte. Une fenêtre trop dense est refusée explicitement.

Le protocole de modification conserve `/simulations` puis `/simulations/:id/apply`,
ses versions, ses droits, ses clés d'idempotence et les contraintes PostgreSQL.
Une proposition porte toujours au plus 100 opérations demandées. Les conséquences
peuvent couvrir leur chaîne dépendante. Le calcul local charge la chaîne complète,
les ressources possibles et leurs réservations concurrentes, y compris les postes
partageant une machine. L'application relit et recalcule les données canoniques
sous verrou ; un aperçu ancien ne peut pas écraser une modification concurrente.

## Calcul et vérification

Le calendrier est développé par intervalles horaires ; les changements d'heure
utilisent un parcours minute par minute. Des tests comparent ce résultat à un
oracle minute en Europe/Paris, New York, Lord Howe et Katmandou. Le moteur indexe
les dépendances et parcourt les intervalles de capacité sans produit cartésien.
Les calculs de plus de 250 opérations passent par deux workers, une file de 16
attentes et un délai de 8 s comprenant l'attente. Une annulation libère le calcul.

Le worker des prévisions accepte 10 000 opérations, groupe les lectures par OF,
écrit les projections en lot et vérifie la révision avant publication. Un résultat
obsolète laisse le travail durable en attente. Le budget de recalcul local ci-dessus
mesure les conséquences d'un déplacement ; il ne mesure pas le délai du worker
matière ni un recalcul complet de l'apprentissage `LEARN`.

## Banc reproductible

- `scripts/performance/planning-engine.cjs` : moteur seul, graphe déterministe,
  empreinte du jeu, calendrier annuel et chaîne locale.
- `provision-isolated.sh` : cluster PostgreSQL séparé sur le port 55970, schéma seul.
- `bootstrap-isolated.cjs` puis `seed-planning.cjs` : références statiques, 50 machines
  réparties en cinq familles, 1 000 OF de dix phases, calendriers ouvrés,
  8 000 engagements et 2 000 opérations à planifier, 16 lecteurs et 4 planificateurs.
- `runtime.cjs --api` : API compilée, configuration de test isolée, profil SQL,
  mémoire, CPU et retard de boucle événementielle. Les identifiants de test sont
  créés hors du dépôt et ne doivent jamais être inclus dans les preuves.
- `verify-planning.cjs` : équivalence avec le calcul des 10 000 opérations,
  lecture seule, application idempotente, pagination après écriture et rejet d'obsolescence.
- `planning-http.cjs` : sessions issues de vraies connexions, 16 lecteurs toutes
  les 5 s et 4 planificateurs toutes les 15 s, espacés de 3 s ; une simulation
  globale par minute et une chaîne complète sur cinq déplacements. Les durées
  incluent le réseau. `PERF_SECONDS=1800`, `PERF_CAMPAIGN=campaign-1`, puis 2 et 3.
- Frontend : `scripts/planning-performance.cjs`, avec `PERF_BROWSER_RUNS=100`,
  build Vite, Chromium, nouveau contexte et cache désactivé à chaque navigation.

Le garde de préparation vérifie le nom de base, le port et `data_directory` avant
toute écriture. L'API utilise un rôle SQL sans privilège superutilisateur. Le cluster
et l'API sont accessibles sur loopback, par tunnel SSH depuis le poste de mesure.
Les règles de connexion et d'autorisation de l'application restent actives.

Ordre d'exécution sur une répétition neuve :

1. Préparer le cluster avec `bash scripts/performance/provision-isolated.sh` sur
   l'hôte PostgreSQL 17. Le schéma source est celui de `cerp_test` sur le socket
   local par défaut ; la destination est exclusivement le cluster privé 55970.
   La source doit contenir les migrations du planning v2. Le rôle d'exécution
   `cerp_app` reçoit les droits sur les tables et séquences du cluster privé.
2. Depuis le checkout backend, ouvrir le tunnel PostgreSQL, définir
   `DATABASE_URL=postgresql://cerp_e2e@127.0.0.1:55970/cerp_test`, puis lancer
   `node scripts/performance/bootstrap-isolated.cjs` et
   `node scripts/performance/seed-planning.cjs`. Le générateur refuse une table
   d'opérations déjà remplie et crée les secrets synthétiques dans le dossier
   frère `performance-runtime`, hors Git.
3. Compiler le backend avec les dépendances du lockfile. Copier `dist`,
   `package.json`, `package-lock.json` et `scripts/performance` dans le répertoire
   privé `/tmp/cerp-planning-perf-970/api`, puis y installer les dépendances avec
   `npm ci --omit=dev --ignore-scripts`. Copier uniquement les secrets nécessaires
   dans le dossier frère privé `performance-runtime` et appliquer le mode 600.
   Lancer `node scripts/performance/runtime.cjs --api` depuis ce checkout privé.
4. Ouvrir le tunnel API 50970. Copier son `api-environment.json` vers le dossier
   de mesure local. Compiler le frontend avec `VITE_API_BASE_URL=/api/v1` et
   `VITE_API_PROXY_TARGET=http://127.0.0.1:50970`, puis lancer la prévisualisation
   via `node scripts/performance/runtime.cjs --frontend` depuis le backend local.
5. Exécuter `verify-planning.cjs` avant la charge, puis les trois campagnes HTTP
   successives de 1 800 s et les 100 ouvertures du navigateur pendant la charge.
   Chaque nom de campagne doit être neuf : les traces NDJSON sont ajoutées en
   fin de fichier. Une relance exploratoire doit utiliser un autre nom.
6. Après les trois campagnes, copier `api-metrics.ndjson` et `sql-profile.json`
   depuis le serveur sous les noms locaux `api-metrics-final.ndjson` et
   `sql-profile-final.json`. Exécuter depuis le frontend
   `node scripts/planning-command-smoke.cjs` : cette vérification annule un
   glisser-déposer, puis propose et confirme un véritable déplacement synthétique.
   Ses deux durées ponctuelles ne sont pas des percentiles. Exécuter ensuite
   `node scripts/performance/report-planning.cjs` depuis le backend.
   Le rapport vérifie les durées, les empreintes des builds, les erreurs et les
   budgets, et conserve uniquement des mesures synthétiques dans l'archive publique.

Les familles et les durées de gamme sont variées. La file est volontairement
concentrée sur une famille pour exercer une contention de capacité ; les réservations
engagées occupent les autres familles. Ce jeu ne reproduit pas des observations
matière, qualité ou de progression réelles. Les 50 ressources sont présentes dans
chaque instantané ; les 20 utilisateurs sont des sessions HTTP actives, avec un
navigateur de mesure supplémentaire pendant les ouvertures à froid.

`stop-isolated.sh` arrête uniquement l'API et le cluster de cette répétition,
après vérification du répertoire du processus et du cluster. Il conserve les
données synthétiques et les rapports. Les tunnels et la prévisualisation Vite
locaux sont arrêtés séparément à la fin de la mesure.

## Résultat du 15 septembre 2026

**PASS** : trois campagnes de 30 minutes, chacune avec les 20 sessions prévues,
sur le même build API `6efd4350840a8e12f52e60c19de34f9afc6a5d80891a733178f10bc45054d289`.
Les 17 280 lectures, 1 350 déplacements réels et 90 simulations globales se sont
terminés sans échec et sans reprise après conflit. Chaque simulation globale
examine 10 000 opérations et propose les 2 000 opérations non engagées.

| Mesure | p95 consolidé | Budget | Résultat |
| --- | ---: | ---: | --- |
| Chargement utilisable, 100 ouvertures du build final | 1 287 ms | 3 000 ms | Conforme |
| Enregistrement après confirmation | 498 ms | 1 000 ms | Conforme |
| Simulation globale | 2 118 ms | 10 000 ms | Conforme |
| Recalcul local des conséquences | 458 ms | 2 000 ms | Conforme |

Tous les budgets serveur sont également respectés séparément dans chacune des
trois campagnes. Le parcours API complet du déplacement est à 1 131 ms au p95.
La mémoire résidente médiane est de 537, 524 et 543 Mio selon la campagne ; le
maximum est de 966 Mio. Le CPU médian représente environ 22 % d'un cœur logique.
Le rapport mesure l'API et distingue sa mémoire du tas V8 du thread principal.

Le rapport principal, ses résultats JSON, les captures et l'archive des mesures
se trouvent dans le dépôt frontend, sous `docs/planning/performance-970*`.
L'archive contient 21 420 mesures HTTP, 100 mesures navigateur et 1 080 relevés
serveur. Un contrôle fonctionnel effectué après la charge vérifie l'annulation
du glisser-déposer, sa conservation pendant le défilement et un enregistrement
réel depuis l'interface. Les contrôles PostgreSQL dédiés vérifient également
l'équivalence avec le calcul complet, la lecture seule et l'idempotence.

Validation : 115 tests backend réussis, 22 tests PostgreSQL génériques ignorés
par leur garde de fixture, compilation TypeScript et inventaire OpenAPI validés.
Le périmètre certifié reste `COMMIT`, avec le jeu synthétique documenté ; les
projections asynchrones matière et `LEARN` ne sont pas mesurées par ce budget.
Les essais exploratoires ne sont pas utilisés pour déclarer cette preuve.
Aucun déploiement ni aucune activation en production n'est inclus dans ce travail.
