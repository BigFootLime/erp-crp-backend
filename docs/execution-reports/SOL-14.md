# SOL-14 — preuve backend des runbooks d'exploitation

- Date : 2026-08-11
- Propriétaire : Keenan Martin — administrateur CERP+
- Tâche : #412

Le build réel de l'image d'exploitation a révélé `MODULE_NOT_FOUND: /app/scripts/build/clean-dist.js`. `npm run build` appelle ce nettoyage depuis SOL-13, mais le stage builder ne copiait que `scripts/security`. Le `Dockerfile` copie désormais aussi `scripts/build`, et le contrat Docker empêche sa régression.

Aucune migration ni donnée n'est modifiée. Résultats : suite backend complète PASS (code 0, 24,2 s), typecheck PASS (9,9 s), build local PASS (633 fichiers, 12 s), build Docker PASS (`sha256:74ad29d3...`), smoke ClamAV PASS avec fichier sain, EICAR et limite de récursion en mode `enforce`.

Rollback : retirer ce `COPY` seulement si le script de build est aussi retiré du manifeste ; sinon Coolify et HYPERBOX2 redeviendraient non livrables. Le corpus canonique et le détail des simulations sont dans `crp-systems-web/docs/execution-reports/SOL-14.md`.
