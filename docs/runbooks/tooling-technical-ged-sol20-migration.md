# Runbook opérateur — migration SOL-20 Outillage / dossier technique / GED

- Propriétaire : exploitation CERP+
- Version : 1.0
- Dernière vérification : 2026-08-13

## Symptômes et impact couverts

Ce runbook sert au déploiement ou au retour arrière de
`20260813_sol20_tooling_technical_ged.sql`. Une migration refusée laisse l'ancien
cycle outillage disponible, mais aucun nouveau parcours SOL-20 ne doit être ouvert.
Une incohérence après migration impose de bloquer les nouvelles réservations ; les
retours physiques déjà dus doivent être consignés hors système jusqu'à reprise.

## Préparation sûre

1. Vérifier que frontend, API et worker ciblent le même SHA et la bonne base.
2. Ouvrir une fenêtre sans création/modification d'outil ni upload GED.
3. Exécuter en lecture seule :

   ```powershell
   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260813_sol20_tooling_technical_ged.preflight.sql
   pnpm db:patches:status
   ```

4. Produire la sauvegarde complète chiffrée DB + GED selon SOL-10, puis enregistrer
   sa taille, son SHA-256 et sa capacité de restauration. Ne pas continuer sans
   cette preuve.
5. Confirmer au minimum 60 secondes sans écriture outillage/GED. Le patch abandonne
   après 5 secondes d'attente de verrou et 60 secondes d'exécution.

## Application et validation

```powershell
pnpm db:patches:up -- --dry-run
pnpm db:patches:up -- --only 20260813_sol20_tooling_technical_ged.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260813_sol20_tooling_technical_ged.verify.sql
pnpm db:patches:status
```

Puis vérifier avec deux comptes distincts :

1. un administrateur voit la matrice d'un indice et peut enregistrer les exigences
   d'un brouillon ;
2. un utilisateur standard reçoit `403` sur une réservation ;
3. un opérateur autorisé réserve puis sort un outil pour un indice applicable ;
4. le retry avec la même clé retourne la même preuve, sans seconde sortie ;
5. un indice obsolète est refusé ;
6. retour, casse ou usure apparaît dans l'historique avec acteur et corrélation ;
7. un document `pending`, `infected`, `scan_failed` ou `quarantined` ne valide pas
   la complétude et n'est ni prévisualisé ni téléchargé.

Le service est rétabli uniquement si le verify ne remonte aucun orphelin, doublon,
chevauchement de période ou quantité invalide, et si les sept contrôles passent.

## Arbre de décision et rollback

- Échec avant commit SQL : conserver les logs, corriger le prérequis, rejouer ; ne
  jamais modifier manuellement `cerp_schema_migrations`.
- Échec après migration sans ligne SOL-20 : exécuter le rollback support en fenêtre
  fermée, puis le verify de l'ancienne version.
- Échec avec lignes SOL-20 : le rollback refusera. Geler les écritures, exporter les
  preuves, restaurer le dump pré-migration dans une nouvelle base, comparer les
  comptages et la GED, puis basculer explicitement `DATABASE_URL`.
- Défaut applicatif sans corruption : redéployer les artefacts précédents ; les
  tables additives sont compatibles et doivent rester en place.

Commande de rollback autorisée seulement avant toute preuve :

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260813_sol20_tooling_technical_ged.rollback.sql
```

## Actions interdites et communication

Ne jamais supprimer une ligne d'événement append-only, forcer un verdict antivirus,
réactiver silencieusement un indice obsolète, corriger le stock hors mouvement, ni
appliquer le patch au VPS s'il n'est pas la base primaire désignée. Informer les
utilisateurs du gel des sorties et des retours, de la durée estimée et de la reprise.
Après incident, conserver SHA, chronologie, clés d'idempotence concernées, entités,
cause racine, décision de restauration et actions préventives dans le post-mortem.
