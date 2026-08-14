# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-13T23:31:59.852Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968435 octets, SHA-256 `342f22beca3c93bdb5dc8bf191693a704d70cf0e15f13f0f71a8b8e529e880d1`
- Patches avant/après : 140 / 152
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `687a3a0e5c56d2413ba0e726fec13ab6d32b3113e7a640df01c9673c8990961d` / `687a3a0e5c56d2413ba0e726fec13ab6d32b3113e7a640df01c9673c8990961d`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19605 |
| source_seed | 230 |
| backup | 740 |
| preflight | 130 |
| integrity_before | 630 |
| migration | 395 |
| verify | 180 |
| replay | 123 |
| integrity_after | 1453 |
| negative_gate | 48 |
| rollback | 192 |
| restore | 4334 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
