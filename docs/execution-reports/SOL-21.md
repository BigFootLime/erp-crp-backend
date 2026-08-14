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
- la migration production reste à appliquer dans une fenêtre autorisée selon le
  runbook, après sauvegarde vérifiée. Elle n'a pas été appliquée pendant ce travail.

## Rollback

Un défaut applicatif se traite en redéployant le SHA précédent tout en conservant
les objets additifs. Avant toute préférence réelle, exporter la table puis utiliser
le rollback support dans une session explicitement autorisée. Après usage, geler
les écritures et restaurer le dump pré-migration dans une nouvelle base ; ne jamais
supprimer silencieusement préférences, pointages ou preuves d'exécution.
