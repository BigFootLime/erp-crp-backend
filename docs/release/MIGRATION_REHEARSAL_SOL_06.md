# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-27T12:14:01.126Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36363287 octets
- Sauvegarde : 1968535 octets, SHA-256 `a6e662427640739f204ef59327995464e6efd6b73e8e8a3fdcda470c499b79ff`
- Patches avant/après : 140 / 190
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `20ae4eb2a8729e85e2d1959aff14249be55f085332177cd7785a1cb65676042f` / `20ae4eb2a8729e85e2d1959aff14249be55f085332177cd7785a1cb65676042f`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18879 |
| source_seed | 192 |
| backup | 723 |
| preflight | 155 |
| integrity_before | 559 |
| migration | 1311 |
| verify | 504 |
| replay | 127 |
| integrity_after | 1946 |
| negative_gate | 47 |
| rollback | 627 |
| restore | 4821 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
