# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-16T16:00:01.702Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968412 octets, SHA-256 `fdb0c75e605b2a90c830faeb7e7321a3f5b90e8251f16774f048516f61aa7bf2`
- Patches avant/après : 140 / 166
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `c4c25532a08e296463292b9e2a198e53841b66a13ea41caaa6e24d0755834e3b` / `c4c25532a08e296463292b9e2a198e53841b66a13ea41caaa6e24d0755834e3b`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 20864 |
| source_seed | 232 |
| backup | 818 |
| preflight | 144 |
| integrity_before | 624 |
| migration | 942 |
| verify | 292 |
| replay | 137 |
| integrity_after | 1683 |
| negative_gate | 44 |
| rollback | 537 |
| restore | 4254 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
