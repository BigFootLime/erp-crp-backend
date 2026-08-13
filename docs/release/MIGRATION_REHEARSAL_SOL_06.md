# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-13T08:26:20.403Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36199447 octets
- Sauvegarde : 1954339 octets, SHA-256 `52275685164f28b972461fb5460a71e97315b86eff5d4265c038f43e61598de3`
- Patches avant/après : 140 / 149
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `515c472ae6a05e2d5cedca4576ae1bd020d21d82569f8e9be41b31599335c84b` / `515c472ae6a05e2d5cedca4576ae1bd020d21d82569f8e9be41b31599335c84b`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19162 |
| source_seed | 181 |
| backup | 716 |
| preflight | 140 |
| integrity_before | 572 |
| migration | 264 |
| verify | 166 |
| replay | 116 |
| integrity_after | 1327 |
| negative_gate | 41 |
| rollback | 121 |
| restore | 3965 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
