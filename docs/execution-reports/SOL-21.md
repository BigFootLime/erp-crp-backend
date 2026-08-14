# SOL-21 — Production, atelier et planning (backend)

- Date : 2026-08-14
- Issue : https://github.com/BigFootLime/crp-systems-web/issues/638
- Branche : `feature/638-sol21-production-planning`
- Base initiale : `origin/dev` (`76eb183`), arbre identique à `origin/main` (`039c72e5`)
- ADR : `docs/adr/ADR-0067-production-planning-execution-intelligence.md`

## Diagnostic et cause racine

Le prévu, le réel, les calendriers et les quantités existaient dans des domaines
séparés sans définition décisionnelle commune. La capacité et les conflits
n'étaient pas expliqués par une API unique, les couleurs restaient locales et
l'accès générique au module pouvait être confondu avec une élévation de rôle.
L'intégration réelle a aussi révélé quatre défauts dormants : le rôle applicatif
ne pouvait pas lire `machines` via la vue station, la requête worklist conservait
un paramètre SQL inutilisé (`42P18`), la contrainte de provenance refusait
`OFFLINE_STATION`, et la fin d'une opération après quantité déjà synchronisée
refusait à tort une confirmation sans quantité supplémentaire.

## Choix d'architecture et résultat

- `planning_events`/`of_operations` restent la source du prévu et
  `production_pointages`/`production_quantity_declarations` celle du réel ;
- KPI versionnés `SOL-21.v1` avec formule, unité, période, source, fraîcheur,
  fiabilité et manquants ; aucune donnée absente remplacée par zéro ;
- capacité hebdomadaire dérivée des calendriers, fermetures et indisponibilités,
  avec états chargé/surchargé/goulot et drill-down OF ;
- conflits côté serveur avec cause et action : ressource indisponible,
  chevauchement forcé, ressource réelle différente, pointage >12 h et temps
  prévu manquant ;
- préférences/couleurs par utilisateur, validation, concurrence, audit et
  idempotence transactionnelle ;
- file atelier triée par exécution en cours, prochain ordre prêt, saisie en
  attente et blocage, avec identifiant canonique prêt QR/CODE128 ;
- moteur hors ligne existant conservé : file chiffrée, ordre, horodatage, clé
  stable, reprise, conflit et visibilité de synchronisation ;
- RBAC serveur séparant opérateur, superviseur et planificateur ; un accès module
  ordinaire n'accorde plus implicitement `read_capacity`.

## Fichiers modifiés

- `src/module/planning/` : types, domaine, repository, service, validation,
  middleware RBAC, contrôleur et routes ;
- `src/module/production/` : exécution, worklist station, tri, scan et tests ;
- `src/module/access-control/` : distinction accès module ordinaire/élevé ;
- `db/patches/20260814_planning_execution_intelligence_0021.sql` et supports
  preflight/verify/rollback ;
- `scripts/e2e/seed-isolated.js` et `scripts/migrations/release-gate.js` ;
- tests planning, production, station, RBAC et migration ;
- ADR-0067, documentation HTTP, runbook et présent rapport.

## Migration et changements de données

Migration additive : une table de préférences utilisateur, une fonction de
validation des couleurs, extension validée de la provenance des pointages à
`OFFLINE_STATION`, et privilège SELECT minimal pour la vue station sous
`cerp_app`. Aucune préférence, capacité, couleur ou donnée de production n'est
créée.

Répétition PostgreSQL 16.14 jetable finale : sauvegarde 1 968 435 octets,
SHA-256 `342f22beca3c93bdb5dc8bf191693a704d70cf0e15f13f0f71a8b8e529e880d1` ;
migration 395 ms, verify 180 ms, rejeu à zéro 123 ms, rollback 192 ms,
restauration 4 334 ms ; 152 patchs appliqués, 0 attendu, puis comptages restaurés
identiques. Aucune base HYPERBOX2, Coolify ou production n'a été lue ou écrite.

## Tests exécutés et résultats

| Contrôle | Résultat réel |
|---|---|
| suite backend Vitest complète | PASS — 952 suites, 4 567 réussis, 4 ignorés, 0 échec |
| tests planning/production ciblés | PASS — domaines, routes, validation, RBAC, worklist et fin d'opération |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS — frontière de données production validée |
| `pnpm db:migrations:rehearse` | PASS — backup, preflight, migration, verify, replay, rollback et restore |
| Playwright inter-dépôts complet | PASS — 97/97, Chromium, 474,5 s, 0 retry |
| répétition clavier/souris/tactile | PASS — 30/30, dix répétitions, 0 retry |

Le backend ne déclare pas de script lint. Typecheck, build, tests et contrôle de
migration sont les contrôles disponibles dans son manifeste.

## Vérification navigateur/E2E

Le runner a construit les deux applications, créé PostgreSQL et les stockages
jetables, appliqué les 152 patchs et chargé huit utilisateurs. Le scénario réel
prouve vente → commande → analyse → OF → planning → lancement → pointage → quantité
hors ligne → retry sans doublon → fin → livraison → facture, avec lecture capacité,
préférence idempotente et refus de capacité à l'opérateur. Les 97 scénarios
historiques passent également sans retry.

La première campagne complète a trouvé six échecs `ECONNREFUSED` : la recette UI
historique du poste atelier ciblait son stub sans que le runner le démarre. Le
runner lance maintenant explicitement ce service sur ports loopback contrôlés.
Cette recette vérifie l'UI ; le scénario SOL-21 distinct continue d'utiliser le
vrai backend PostgreSQL.

## Risques, compatibilité et travail restant

- le modèle actuel ne relie pas un calendrier à une machine : exactement un
  calendrier actif est accepté ; zéro ou plusieurs rendent la capacité
  indisponible. Une affectation machine/calendrier nécessitera une décision métier
  et une migration additive ;
- les anciennes quantités sans unité et les opérations sans temps prévu restent
  partielles, conformément à la règle de non-fabrication ;
- le seuil d'encours âgé et les seuils de charge sont contractuels `SOL-21.v1` ;
  tout changement doit versionner la définition ;
- la migration SOL-21 est maintenant appliquée sur `cerp_test` et `cerp_prod` ;
  les autres patchs encore en attente restent hors périmètre et n'ont pas été
  appliqués implicitement par cette fenêtre ciblée.

## Rollback

Un défaut applicatif se traite en redéployant le SHA précédent tout en conservant
les objets additifs. Avant toute préférence réelle, exporter la table puis utiliser
le rollback support dans une session explicitement autorisée. Après usage, geler
les écritures et restaurer le dump pré-migration dans une nouvelle base ; ne jamais
supprimer silencieusement préférences, pointages ou preuves d'exécution.

## Clôture opérationnelle du 14/08/2026

La vérification post-promotion a identifié la cause exacte du reliquat : le
runbook demandait une sélection immuable `--only`, mais
`20260814_planning_execution_intelligence_0021.sql` n'était pas inscrit dans
`IMMUTABLE_ONLY_PATCHES`. Le runner refusait donc correctement toute exécution
ciblée. Le patch est désormais lié à son SHA-256 LF canonique
`ca667814cae65e695ec45dccf407752432aa9e6f7e61b4d9a38ae6fcfd339107`, avec
test de non-régression dans `db-patches.runner.test.ts`.

Preflight réel PostgreSQL 17.10 :

- `cerp_test` : 153 646 771 octets, 2 événements planning, 1 pointage, 1
  calendrier actif ;
- `cerp_prod` : 107 984 563 octets, 0 événement planning, 0 pointage, 0
  calendrier actif ; l'absence de calendrier reste un état métier explicite,
  jamais une capacité nulle fabriquée ;
- 386 927 382 528 octets libres sur le volume de sauvegarde.

Sauvegardes pré-migration AES-256-CBC/PBKDF2, clé séparée et non journalisée :

- test : `/var/backups/cerp/cerp_test_pre_sol21_20260814-185559.dump.enc`,
  73 017 344 octets, SHA-256
  `5251339111f328d86b41d5e4b6fbaff030e35797b71646fad2db20d71af34efe` ;
- production : `/var/backups/cerp/cerp_prod_pre_sol21_20260814-185559.dump.enc`,
  49 544 128 octets, SHA-256
  `2d438bc2f268b42a1823617c16e8fe1f4786b930e95a586727fb0ecdc11e0978` ;
- déchiffrement vérifié par égalité des empreintes des dumps source et
  déchiffrés, puis catalogues `pg_restore` lisibles.

Application ciblée : test puis production ont chacun appliqué exactement un
patch ; preflight, verify, privilège `cerp_app`, ledger et second rejeu à zéro
ont réussi. Une restauration réelle du dump production déchiffré a été faite
dans `cerp_restore_verify_sol21_20260814` : 105 821 875 octets, 18 utilisateurs,
0 événement planning et 0 pointage, sans table ni ledger SOL-21. La base
temporaire a ensuite été supprimée et son absence vérifiée.

Contrôles applicatifs après migration : readiness HYPERBOX2 test et production
HTTP 200, PostgreSQL/GED/antivirus/realtime `up`, et route planning anonyme
refusée HTTP 401. Le correctif du runner passe 24/24 tests ciblés, le typecheck et
le build backend avec frontière de données production validée. La suite Vitest
backend complète a également terminé avec le code 0 en 42,9 s.
