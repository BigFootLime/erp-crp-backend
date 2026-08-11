# SOL-06 — Migration `cerp_prod` autorisée du 2026-08-11

Ce rapport remplace explicitement l'état « non appliqué » de la première édition de `SOL-06-PRODUCTION-READINESS-DEPLOYMENT.md`. Keenan Martin a autorisé la fenêtre d'écriture production le 2026-08-11.

## Résultat

Les patches `20260810_system_reference_data_readiness.sql` et `20260811_production_readiness_center.sql` sont appliqués sur `cerp_prod`. Les fonctions v1/v2 et le trigger de production sont présents, le registre contient exactement les deux lignes attendues et aucune clé étrangère invalide n'a été trouvée.

Le contrôle retourne cinq prérequis : rôles, unités et statuts prêts ; calendrier de production et taux de centre de frais non prêts. Ces deux absences sont volontairement actionnables et continuent de bloquer le démarrage d'une production. Aucune donnée métier fictive n'a été insérée.

## Preflight et sauvegarde

- release immuable exécutée : `a7ace695265dda02b7c1bd295c59df724e588c6f` ;
- PostgreSQL : `17.10` ;
- taille initiale : `105 658 035` octets ; espace disponible : `388 044 980 224` octets ;
- registre initial : `123` patches ;
- sauvegarde : `/var/backups/cerp/cerp_prod_pre_sol06_readiness_20260811-132522.dump` ;
- taille sauvegarde : `49 338 351` octets ; catalogue : `4 165` entrées ;
- SHA-256 : `fd4a9d4df55ca6f61a1d54fcafc34bfd75a26153bd9baa930d0bece7a42cd450` ;
- fichier protégé par propriétaire `postgres` et mode `0600`.

Chaque patch a suivi `status --only`, `up --dry-run --only`, `up --only`, puis son script de vérification. Le deuxième preflight a été rejoué après le premier patch, car il dépend normalement des objets créés par celui-ci.

## Preuve de restauration

La sauvegarde a été restaurée dans `cerp_restore_verify_prod_sol06_20260811`, une base isolée et temporaire. La base restaurée contient les `123` entrées historiques, aucune fonction SOL-06, aucune ligne SOL-06 et zéro clé étrangère invalide. La base temporaire a ensuite été supprimée. Verdict : `RESTORE_PROOF=passed`.

## Vérifications service

- endpoint public `/health/live` : HTTP 200, version `a7ace` ;
- endpoint public `/health/ready` : HTTP 200 ; DB, GED, antivirus et realtime `up` ;
- services HYPERBOX2 production et test : readiness `up`, version `a7ace`.

## Rollback

Arrêter les écritures, conserver l'état incident, restaurer le dump vérifié dans une base neuve, contrôler le registre, les comptages et la cohérence GED, puis basculer sous approbation humaine. Le rollback SQL test-only ne doit pas être utilisé sur `cerp_prod`.

## Reste métier

Les utilisateurs autorisés doivent saisir dans le centre de préparation les vrais calendriers, centres de frais et taux horaires. La production demeure protégée tant que ces données ne sont pas complètes.
