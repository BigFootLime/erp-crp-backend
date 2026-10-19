# ADR-20261019 — Rôles runtime API et worker bleu/vert (#1381)

## Décision

Le même binaire accepte `CERP_RUNTIME_ROLE=api|worker|all`. Sans variable, il
conserve `all`, pour rester compatible avec l'exploitation actuelle.

- `api` ne crée aucun timer, worker, Socket.IO ou connexion de leadership ; il
  sert uniquement l'API HTTP.
- `worker` n'expose pas l'API métier. Il exécute les maintenances seulement après
  avoir acquis le leadership PostgreSQL.
- `all` reste le mode transitoire compatible : API et worker dans le même
  processus, mais les maintenances attendent aussi le leadership.

Le leader est un verrou consultatif PostgreSQL **sessionnel**, détenu par un
client dédié. Sa perte arrête les maintenances et termine le processus : il ne
continue jamais à envoyer des effets externes après perte de son fencing
primaire. Les claims, leases, clés d'idempotence et délais déjà présents dans
les files restent nécessaires : un verrou de leader ne rend pas un appel réseau
exactly-once.

La disponibilité HTTP ne dépend pas du leadership en rôle `api`. En `all`, la
readiness inclut l'état concret du worker et reste négative tant que le
leadership requis n'est pas acquis. Un worker seul ne publie aucun gateway
métier.

## Bascule

La première adoption n'est pas une overlap transparente : les instances
anciennes démarrent leurs timers sans participer au verrou. Il faut donc
arrêter ou drainer leurs maintenances selon une procédure coordonnée avant
lancer un worker avec ce contrat. Ensuite, l'API VPS et l'API HYPER peuvent être
`api`; le worker unique est préféré sur HYPER, qui a l'accès local aux données
et au GED. Le verrou PostgreSQL partagé reste inter-hôtes.

Pour une bascule ultérieure : démarrer l'API verte en rôle `api`, attendre sa
readiness, transférer le leadership du worker, puis drainer les requêtes et
WebSockets de l'ancienne API. Les JWT, la base PostgreSQL, le Directory et les
origines CORS doivent rester identiques pendant ce recouvrement. Un rollback
reroute le trafic et restaure le worker précédent ; il ne réécrit jamais les
queues ou les historiques durables.

## Limites

Cette décision ne modifie ni les flux métier ni les contrats HTTP. Elle ne
prouve pas une absence d'interruption lors de la migration initiale et ne
promet pas exactly-once pour un prestataire externe après une panne réseau.