# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-15T11:11:32.936Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968347 octets, SHA-256 `05e505de971e66d42ef5b117f87e9c532e1fa1142366a4dbf481b5f47935d35b`
- Patches avant/après : 140 / 165
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `218759e7dc4505d334be5d506194622ca51a3b10b5746097aae673b30328bf9d` / `218759e7dc4505d334be5d506194622ca51a3b10b5746097aae673b30328bf9d`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18698 |
| source_seed | 196 |
| backup | 747 |
| preflight | 195 |
| integrity_before | 624 |
| migration | 901 |
| verify | 291 |
| replay | 177 |
| integrity_after | 1655 |
| negative_gate | 42 |
| rollback | 485 |
| restore | 4170 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
