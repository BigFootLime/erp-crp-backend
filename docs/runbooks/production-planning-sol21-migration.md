# Runbook opérateur — migration SOL-21 planning et exécution

- Propriétaire : exploitation CERP+
- Version : 1.0
- Dernière vérification : 2026-08-14
- Patch : `20260814_planning_execution_intelligence_0021.sql`

## Symptômes et impact

Ce runbook couvre le déploiement, le refus ou le retour arrière du schéma SOL-21.
Une migration absente empêche la persistance serveur des préférences et peut
refuser les pointages issus de la file hors ligne. Une capacité indisponible par
absence de calendrier est un prérequis métier, pas un incident de migration.

## Préparation sûre

1. Confirmer que frontend et API ciblent le même SHA et la base attendue.
2. Geler les changements de planning et les ouvertures de session atelier.
3. Vérifier en lecture seule :

   ```powershell
   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_planning_execution_intelligence_0021.preflight.sql
   pnpm db:patches:status
   ```

4. Produire la sauvegarde chiffrée DB selon SOL-10. Enregistrer taille, SHA-256,
   âge et preuve de restauration. Ne pas continuer sans cette preuve.
5. Vérifier PostgreSQL >= 14, les relations sources, les fuseaux des calendriers,
   la vue d'occupation et la fonction `tg_set_updated_at()`.

## Application et validation

```powershell
pnpm db:patches:up -- --dry-run --only 20260814_planning_execution_intelligence_0021.sql
pnpm db:patches:up -- --only 20260814_planning_execution_intelligence_0021.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_planning_execution_intelligence_0021.verify.sql
pnpm db:patches:status -- --check --only 20260814_planning_execution_intelligence_0021.sql
```

Valider ensuite avec trois comptes distincts :

1. l'opérateur ouvre sa station, voit l'encours puis les opérations prêtes, mais
   reçoit `403` sur `/planning/execution-intelligence` ;
2. le superviseur consulte les blocages et corrige un pointage selon le workflow
   existant ;
3. le planificateur lit la capacité, ouvre le drill-down OF et enregistre ses
   préférences ; le retry avec la même version ne crée aucun doublon ;
4. une quantité hors ligne est synchronisée une seule fois avec la provenance
   `OFFLINE_STATION`, puis l'opération peut être terminée ;
5. les KPI sans calendrier, unité ou temps prévu restent explicitement
   `UNAVAILABLE`/`PARTIAL`.

Le service est rétabli uniquement si le verify passe, si la vue d'occupation est
lisible sous le rôle applicatif et si ces contrôles n'exposent ni élévation de droit
ni doublon.

## Arbre de décision et rollback

- Échec avant commit : conserver les logs, corriger le prérequis et rejouer. Ne
  jamais modifier manuellement `cerp_schema_migrations`.
- Échec applicatif sans corruption : redéployer l'ancien backend ; les objets
  additifs restent compatibles.
- Retour avant toute préférence : exporter la table, marquer explicitement
  l'export dans la session SQL, puis exécuter le support de rollback.
- Préférences déjà utilisées : ne pas les supprimer. Geler les écritures,
  restaurer le dump pré-migration dans une nouvelle base, comparer comptages et
  checksum, puis promouvoir explicitement cette base.

```powershell
pg_dump $env:DATABASE_URL --table=public.planning_user_preferences --format=custom --file=planning-user-preferences.dump
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -c "SET cerp.sol21_preferences_exported = 'yes';" -f db/patches/support/20260814_planning_execution_intelligence_0021.rollback.sql
```

La seconde commande doit être exécutée dans une session unique adaptée par
l'opérateur ; un `SET` dans une connexion séparée n'autorise pas le rollback.

## Actions interdites et communication

Ne jamais convertir une capacité absente en zéro, supprimer un pointage, changer
la source d'un événement, contourner le RBAC, éditer le ledger de migration ou
appliquer le patch sur une base non désignée. Informer les utilisateurs du gel,
des entités touchées, de la décision de reprise et de la validation métier. Tout
incident conserve SHA, fenêtre, comptes de test, OF concernés, cause racine et
mesure préventive dans le post-mortem.
