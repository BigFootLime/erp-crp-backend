# Runbook opérateur — migration SOL-22 qualité et traçabilité

- Propriétaire : exploitation CERP+
- Version : 1.0
- Dernière vérification : 2026-08-14
- Patch : `20260814_sol22_quality_intelligence.sql`

## Symptômes et impact

Ce runbook couvre le déploiement, le refus ou le retour arrière du schéma SOL-22.
Une migration absente rend les endpoints d'intelligence indisponibles et empêche
l'affectation structurée des causes et l'enregistrement idempotent des coûts. Une
métrique `UNAVAILABLE` ou un SPC désactivé par prérequis manquant n'est pas un
incident de migration.

## Préparation sûre

1. Confirmer le SHA backend/frontend et le nom exact de la base ciblée.
2. Geler brièvement les modifications de NC, CAPA et paramètres qualité.
3. Exécuter le preflight en lecture seule :

   ```powershell
   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_sol22_quality_intelligence.preflight.sql
   pnpm db:patches:status
   ```

4. Produire un dump PostgreSQL hors de la base active, calculer son SHA-256 et
   démontrer sa restauration dans une base jetable. Ne pas continuer sans preuve.
5. Vérifier l'espace disque, PostgreSQL >= 14, les relations Qualité/Métrologie/
   Traçabilité et l'absence de migration en attente ou de checksum divergent.

## Application et validation

```powershell
pnpm db:patches:up -- --dry-run --only 20260814_sol22_quality_intelligence.sql
pnpm db:patches:up -- --only 20260814_sol22_quality_intelligence.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_sol22_quality_intelligence.verify.sql
pnpm db:patches:status -- --check --only 20260814_sol22_quality_intelligence.sql
```

Valider ensuite :

1. un responsable Qualité affecte une cause avec `expected_updated_at`, rejoue la
   requête et retrouve le même état sans doublon ;
2. il enregistre un coût avec `Idempotency-Key`, le rejoue et retrouve le même UUID ;
3. un opérateur reçoit `403` en lecture des indicateurs et en création de coût ;
4. une CAPA exigeant une preuve refuse `VERIFIED` sans document et l'accepte avec
   vérificateur, date, efficacité et preuve active ;
5. une politique SPC incomplète reste désactivée ; une politique complète ne
   devient fiable qu'après les sous-groupes et la cadence requis ;
6. un instrument en quarantaine reste bloqué, une échéance suit sa stratégie
   `BLOCK`/`WARN`, et le centre liste les équipements bloquants ;
7. l'enquête d'un lot livré contient les nœuds matière et livraison, expose ses
   liens manquants et ne fabrique pas de temps métier d'enquête.

Le service ne revient en production que si le verify, les contrôles d'idempotence,
les refus RBAC et la recette navigateur passent.

## Arbre de décision et rollback

- Échec avant commit : conserver le log, corriger le prérequis puis rejouer ; ne
  jamais éditer `cerp_schema_migrations`.
- Échec applicatif sans corruption : redéployer l'ancien backend ; conserver les
  objets additifs.
- `cerp_test` sans donnée SOL-22 : exécuter le rollback support dans une session
  contrôlée après export et snapshot.
- Toute cause, coût ou politique déjà utilisée : le rollback destructif doit
  refuser. Geler les écritures, restaurer le dump dans une nouvelle base, vérifier
  contraintes/comptages puis promouvoir explicitement cette base.

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_sol22_quality_intelligence.rollback.sql
```

## Actions interdites et communication

Ne jamais supprimer une écriture de coût ou un audit, réécrire une politique SPC
retirée, convertir un manque en zéro, contourner le gate métrologique/RBAC, ni
exécuter le rollback sur `cerp_prod`. Informer les utilisateurs du gel, du SHA, de
la base, du verdict de reprise et des NC/équipements touchés. Le post-mortem conserve
logs corrélés, patch, checksum du dump, cause racine et validation métier.
