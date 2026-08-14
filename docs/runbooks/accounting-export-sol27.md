# Runbook — Export comptable SOL-27

- Propriétaire : Direction financière / Keenan Martin
- Version : 2026-08-14
- Gravité par défaut : P1 si l'export de période est bloqué ; P0 seulement si une
  écriture non rapprochée a déjà été importée dans le logiciel comptable.

## Préparation obligatoire

1. Identifier le logiciel comptable, sa version, son format d'import et son
   environnement de test. Ne jamais déclarer le format générique compatible sans
   essai d'import.
2. Faire valider par le comptable les journaux, comptes tiers, comptes de vente,
   comptes TVA, comptes bancaires, modes de règlement, axes et date d'effet.
3. Créer une nouvelle version de mapping dans **Facturation → Exports comptables**.
   Ne jamais modifier une version déjà utilisée.
4. Vérifier période ouverte, séquences légales, devises ISO, ventilations TVA et
   absence de pièces incomplètes.

## Procédure normale

1. Choisir période et types de pièces, puis lancer **Prévisualiser**.
2. Traiter tous les `BLOCKER`. Un avertissement doit être compris avant validation.
3. Comparer nombre de sources, nombre de lignes et totaux débit/crédit par devise.
4. Cliquer **Valider**. Si une source a changé, abandonner ce lot et recréer une
   prévisualisation ; ne pas contourner le contrôle d'empreinte.
5. Cliquer **Générer**, télécharger l'artefact et conserver le SHA-256 affiché.
6. Importer le fichier dans l'environnement test du logiciel comptable.
7. Comparer le rapport ERP ↔ export : nombre de pièces, lignes, débit et crédit par
   devise. Conserver le journal d'import du logiciel avec le numéro de lot CERP+.
8. Après validation comptable, reproduire l'import dans la société/période cible.

## Échec, doublon ou correction

- `SOURCE_CHANGED` : une pièce a évolué depuis la prévisualisation. Refaire un lot.
- `SOURCE_ALREADY_EXPORTED` : retrouver le lot propriétaire. Ne jamais exporter une
  seconde fois sans décision comptable documentée.
- Lot incorrect non importé : annuler logiquement avec un motif explicite, puis
  utiliser **Réexporter** pour créer une nouvelle preuve.
- Lot déjà importé : ne pas supprimer ou réimporter. Demander au comptable la pièce
  de correction/contrepassation dans son logiciel, puis rapprocher les références.
- Timeout client : relancer avec la même `Idempotency-Key`; une nouvelle clé pourrait
  créer une nouvelle intention.

## Vérifications sûres

```powershell
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm e2e:accounting-export:isolated
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm db:migrations:preflight
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm db:patches:status
```

Ne jamais lancer `db:patches:up` en production sans sauvegarde, cible explicite,
fenêtre autorisée et contrôle `--only` de l'empreinte immuable.

## Rollback

- Avant migration : dump PostgreSQL custom, SHA-256, catalogue lisible et espace
  libre vérifié.
- Avant tout lot : redéployer l'application précédente suffit ; conserver les tables.
- Base test sans lot : exécuter le rollback SOL-27.
- Base contenant un lot : le rollback SQL refuse. Restaurer le dump dans une nouvelle
  base, vérifier intégrité et comptages, puis basculer explicitement.

## Ce qui reste dans le logiciel comptable

Import définitif, acceptation/rejet détaillé, lettrage, rapprochement bancaire,
contrepassation, écritures manuelles, déclarations, clôture et conservation légale
selon le contrat du logiciel. Le numéro de lot et le SHA CERP+ doivent rester liés au
journal d'import externe.
