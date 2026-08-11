# Mise à niveau de base — procédure opérateur SOL-06

Cette procédure est la seule procédure supportée pour une mise à niveau CERP+. Les commandes de validation sont en lecture seule, sauf l'application explicite des patches. La répétition locale n'accepte que PostgreSQL sur loopback, dans `cerp_test`, et détruit son conteneur à la fin.

## 1. Préparer la décision de valorisation

`stock.valuation_method` est une donnée de décision : elle ne doit jamais être inventée par une migration. Finance/Direction industrielle fournit un document approuvé et l'opérateur enregistre exactement cette décision avant le preflight :

```sql
BEGIN;
INSERT INTO public.erp_settings (key, value_text, value_json, updated_at)
VALUES (
  'stock.valuation_method',
  '<WEIGHTED_AVERAGE|FIFO|SPECIFIC_IDENTIFICATION>',
  jsonb_build_object(
    'method', '<WEIGHTED_AVERAGE|FIFO|SPECIFIC_IDENTIFICATION>',
    'definition', '<définition approuvée>',
    'unit', 'METHOD',
    'period_start', '<YYYY-MM-DD>',
    'period_end', NULL,
    'source', '<référence du document approuvé>',
    'freshness_at', '<ISO-8601>',
    'reliability', '<VERIFIED|DECLARED>'
  ),
  now()
)
ON CONFLICT (key) DO UPDATE SET
  value_text = EXCLUDED.value_text,
  value_json = EXCLUDED.value_json,
  updated_at = now();
COMMIT;
```

Les valeurs entre chevrons sont obligatoires. `TEST_ONLY` est réservé à la fixture isolée et ne passe pas le gate d'exploitation.

## 2. Sauvegarder et prouver la sauvegarde

Sur l'hôte opérateur disposant de `pg_dump`, avec une URL fournie par le gestionnaire de secrets :

```bash
export CERP_MIGRATION_OPERATOR='<identité opérateur>'
export DATABASE_URL='<secret injecté, jamais copié dans un ticket>'
export CERP_MIGRATION_BACKUP_FILE="/var/backups/cerp/cerp_pre_upgrade_$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --no-acl --file="$CERP_MIGRATION_BACKUP_FILE" "$DATABASE_URL"
export CERP_MIGRATION_BACKUP_SHA256="$(sha256sum "$CERP_MIGRATION_BACKUP_FILE" | cut -d' ' -f1)"
pg_restore --list "$CERP_MIGRATION_BACKUP_FILE" >/dev/null
```

Le gate refuse un fichier vide, un SHA-256 différent et un volume de sauvegarde dont l'espace libre est inférieur à deux fois la taille du dump. Le backup VPS/Coolify reste obligatoire en plus du dump opérateur.

## 3. Preflight sans écriture

Pour une cible distante ou dont le nom ressemble à la production, l'acquittement ne débloque que les lectures :

```bash
export CERP_MIGRATION_READONLY_APPROVED=1
npm run db:migrations:inventory
npm run db:migrations:preflight
npm run db:patches:status
npm run db:patches:up -- --dry-run
```

Le preflight vérifie : PostgreSQL 14+, extensions, registre et SHA des patches, sauvegarde, espace disque, FK non validées, doublons de codes, unités, chaîne magasin/emplacement, calendrier, taux de centres de frais, rôles et politique de valorisation. Un échec structurel interdit l'application. L'absence de calendrier réel ou de taux strictement positif est rapportée comme prérequis métier manquant, mais n'empêche pas l'installation du centre guidé qui permettra de le corriger.

## 4. Fenêtre de migration

1. passer l'API en maintenance et attendre la fin des transactions ;
2. conserver l'ancien artefact frontend/backend ;
3. vérifier à nouveau le SHA-256 de la sauvegarde ;
4. exécuter `npm run db:patches:up` ;
5. exécuter les fichiers `db/patches/support/20260810_system_reference_data_readiness.verify.sql` puis `db/patches/support/20260811_production_readiness_center.verify.sql` avec `ON_ERROR_STOP=1` ;
6. exécuter `npm run db:migrations:integrity` ;
7. redémarrer le backend de la même release, puis le frontend ;
8. vérifier un mouvement stock, une planification et un lancement OF ;
9. quitter la maintenance seulement après ces contrôles.

Le patch SOL-06 prend un verrou `ACCESS EXCLUSIVE` bref lors de l'ajout des colonnes à `erp_settings`, met à jour au plus une ligne, puis crée deux fonctions et trois triggers. Ne pas l'appliquer pendant une transaction longue. Les temps réellement mesurés sont publiés dans `docs/release/MIGRATION_REHEARSAL_SOL_06.md`.

## 5. Contrôles d'intégrité

`npm run db:migrations:integrity` compte toutes les tables publiques, contrôle les contraintes, les doublons, chaque clé étrangère par anti-jointure, les orphelins, le registre de migrations et les prérequis métier. Les anciennes contraintes `CHECK NOT VALID` sont listées séparément ; une FK `NOT VALID` reste bloquante.

## 6. Retour arrière réaliste

Le rollback principal est une restauration dans une base neuve, jamais un effacement en place :

```bash
createdb '<cerp_restore_YYYYMMDD_HHMM>'
pg_restore --exit-on-error --no-owner --no-acl --dbname='<cerp_restore_YYYYMMDD_HHMM>' "$CERP_MIGRATION_BACKUP_FILE"
```

Puis :

1. exécuter les contrôles d'intégrité sur la base restaurée ;
2. comparer les comptages et l'empreinte au rapport avant migration ;
3. arrêter les écritures ;
4. basculer le secret `DATABASE_URL` vers la base restaurée ;
5. redéployer l'artefact applicatif précédent ;
6. conserver la base ayant échoué en lecture seule pour diagnostic.

Le script `20260810_system_reference_data_readiness.rollback.sql` est uniquement une preuve sur `cerp_test` avec `SET cerp.migration_rehearsal = on`. Il ne remplace jamais la restauration en production.

Le script `20260811_production_readiness_center.rollback.sql` suit la même règle : il restaure le gate v1 uniquement dans la base jetable de répétition. En production, le rollback reste une restauration complète dans une base neuve afin de conserver un retour cohérent entre schéma et données.

## 7. Paramétrage guidé après migration

1. ouvrir `/administration/preparation-production` ;
2. traiter chaque prérequis signalé avec le bouton proposé ;
3. saisir les calendriers réels dans `/planning/parametres/calendriers` ;
4. saisir les centres de frais et leurs taux strictement positifs dans `/methodes/centres-frais` avec source et date d'effet ;
5. revenir au centre de préparation et vérifier que chaque état est prêt ;
6. réaliser un lancement OF de recette avant de sortir de maintenance.

L'alerte est visible par les utilisateurs Production, mais seuls les rôles autorisés peuvent modifier chaque référentiel. Ne jamais saisir une valeur temporaire pour faire disparaître le blocage.

## 8. Répétition locale complète

```bash
npm run db:migrations:rehearse
```

La commande démarre PostgreSQL épinglé par digest en tmpfs, reconstruit la version précédente réaliste, seed les référentiels déterministes, sauvegarde, préflight, migre, vérifie, rejoue à zéro patch, prouve un refus négatif, exécute le rollback test-only, restaure dans une base neuve, compare les empreintes et détruit le conteneur.
