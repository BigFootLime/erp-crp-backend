# API Planning de production — issue #171

Base : `/api/v1/planning`. Toutes les routes exigent une session authentifiée et un rôle Planning
exactement reconnu (direction, production/programmation, atelier, secrétariat ou administration
système). Une chaîne contenant seulement le mot `admin`, telle que `administratif`, n'accorde aucun
droit. Le chevauchement forcé reste limité à la direction, l'administration et la responsabilité
production/atelier.

## Convention temporelle

Les entrées utilisent ISO-8601 avec `Z` ou un offset explicite. Les dates locales sans fuseau sont
refusées afin d'éviter les heures inexistantes ou doublées lors des changements DST Europe/Paris.
PostgreSQL stocke des `timestamptz`. Tous les intervalles sont semi-ouverts `[start_ts, end_ts)` :
deux événements adjacents sont autorisés, un chevauchement positif est un conflit.

## Routes

| Méthode | Route | Objet |
| --- | --- | --- |
| GET | `/resources` | Machines et postes planifiables |
| GET | `/events` | Fenêtre bornée ; `limit` 2 000 par défaut, 5 000 maximum, `offset`; `total` reste exhaustif |
| GET | `/events/:id` | Détail, commentaires et documents |
| POST | `/events` | Création contrôlée, ressource et conflit recalculés côté serveur |
| PATCH | `/events/:id` | Déplacement/resize/statut avec `expected_updated_at` |
| DELETE | `/events/:id` | Archivage logique audité |
| POST | `/events/:id/restore` | Restauration après revalidation ressource, chevauchement et verrou AR |
| POST | `/events/:id/comments` | Commentaire authentifié, corps Zod strict |
| POST | `/events/:id/documents` | Ajout authentifié de documents |
| GET | `/events/:id/documents/:docId/file` | Lecture authentifiée du contenu d'un document |
| POST | `/autoplan` | Application séquentielle avec créations, éléments ignorés et résumé partiel explicite |
| POST | `/validate-for-ar` | Fait progresser vers `AR_PRET`; n'envoie jamais l'AR |

## Concurrence, archive et autoplan

Un PATCH muni d'un `expected_updated_at` périmé renvoie `409 PLANNING_STALE` avec
`details.current_updated_at`. Aucun écrasement silencieux n'est attendu du client. L'archivage ne
supprime aucune preuve. Une restauration revient à `PLANNED`, réévalue la disponibilité et peut
répondre `409 PLANNING_CONFLICT`, `PLANNING_RESOURCE_BLOCKED` ou `PLANNING_LOCKED_AFTER_AR`.

L'autoplan conserve son contrat de résultat partiel explicite. Les motifs sont
`ALREADY_PLANNED`, `MISSING_RESOURCE`, `RESOURCE_BLOCKED`, `LOCKED_AFTER_AR`, `NO_OPERATIONS`, `NO_SLOT` ou
`FAILED`; `summary.partial` indique qu'au moins une création et un rejet ont coexisté. Le lot n'est
pas encore atomique et aucune clé d'idempotence Planning n'est persistée : les mutations ne doivent
pas être retentées automatiquement. Une évolution nécessiterait une migration additive avec
preflight, verify et rollback sur `cerp_test` avant toute autre décision.

La restauration rétablit actuellement le statut `PLANNED`, y compris pour un événement personnalisé
ou de maintenance qui avait un autre statut avant archivage : la conservation du statut antérieur
reste une évolution de schéma. Les machines et les postes sont également traités comme deux domaines
de conflit distincts ; la règle de capacité entre un poste et sa machine associée doit être confirmée
avec l'atelier avant tout durcissement. Les contraintes d'exclusion PostgreSQL dépendent enfin de
`btree_gist` et doivent être vérifiées sur `cerp_test` lors du prochain preflight de base de données.

## Validation vers AR

La validation est transactionnelle au niveau de la commande. Une commande déjà prête est retournée
avec `ALREADY_READY`, un AR envoyé avec `AR_ALREADY_SENT`, une transition métier refusée avec
`WORKFLOW_NOT_ADVANCED` et une commande sans OF planifié avec `NO_PLANNED_OF`. Le résultat ouvre le
flux de préparation AR ; il ne constitue jamais un envoi.

## Erreurs principales

- `400 VALIDATION_ERROR`, `MISSING_RESOURCE`, `OF_OPERATION_MISMATCH`
- `403 FORBIDDEN`, `PLANNING_FORCE_OVERLAP_FORBIDDEN`
- `404 PLANNING_EVENT_NOT_FOUND`, `MACHINE_NOT_FOUND`, `POSTE_NOT_FOUND`
- `409 PLANNING_CONFLICT`, `PLANNING_STALE`, `PLANNING_RESOURCE_BLOCKED`,
  `PLANNING_LOCKED_AFTER_AR`, `PLANNING_NOT_ARCHIVED`, `PLANNING_OPERATION_RUNNING`

Les actions créer, modifier, archiver, restaurer, commenter, documenter et valider vers AR sont
auditées avec le contexte de requête existant. Aucun chemin interne ni secret ne doit apparaître
dans une réponse ou un journal.
