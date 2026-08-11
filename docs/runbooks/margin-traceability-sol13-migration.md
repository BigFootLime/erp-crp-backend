# Runbook opérateur — migration SOL-13 des marges

## Fenêtre et sauvegarde

La modification de contraintes prend brièvement un verrou exclusif sur quatre tables de marge. Prévoir une fenêtre sans écriture de taux, d'entrées ni de snapshots. Le patch abandonne après 5 secondes d'attente au lieu de bloquer l'ERP.

1. Identifier le SHA applicatif et la base cible.
2. Exécuter `db/patches/support/20260811_margin_traceability_0002.preflight.sql` en lecture seule.
3. Produire un dump PostgreSQL chiffré selon le runbook SOL-10, puis vérifier taille et SHA-256.
4. Appliquer `db/patches/20260811_margin_traceability_0002.sql` via le runner de migrations.
5. Exécuter `db/patches/support/20260811_margin_traceability_0002.verify.sql`.
6. Vérifier un devis et un OF : quatre perspectives, entrées manquantes explicites, export CSV avec preuve v2.

## Contrôles post-migration

- aucune ligne v2 sans définition, unité, période ou fiabilité;
- contraintes de bases contenant `PLANNED`, `QUOTED`, `STANDARD`, `UPDATED`, `ACTUAL`;
- `REWORK` accepté comme catégorie;
- anciennes preuves `PLANNED` toujours listables;
- application et worker au même SHA.

## Retour arrière

Avant toute preuve v2, le rollback fourni est autorisé uniquement sur `cerp_dev`/`cerp_test`. Après une écriture v2 ou en production : arrêter les écritures, conserver/exporter les preuves créées si nécessaire, puis restaurer le dump pré-migration. Ne jamais supprimer manuellement une preuve append-only.
