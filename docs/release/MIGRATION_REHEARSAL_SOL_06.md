# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T11:09:13.452Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968424 octets, SHA-256 `032b963c8f078e0aa5b30304dbee2004d083c97c950c452e3968687a9fbe53b0`
- Patches avant/après : 140 / 156
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `73d3223f43345a6dff0877afb4ae30e5ccf531227789d08548fe61f58dea85f5` / `73d3223f43345a6dff0877afb4ae30e5ccf531227789d08548fe61f58dea85f5`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18840 |
| source_seed | 200 |
| backup | 737 |
| preflight | 136 |
| integrity_before | 593 |
| migration | 532 |
| verify | 241 |
| replay | 127 |
| integrity_after | 1456 |
| negative_gate | 45 |
| rollback | 308 |
| restore | 4034 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
