# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T16:08:33.064Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968442 octets, SHA-256 `2736b95040d018030db6eb91a022fb0f52c2eb4ecd45da1722d9a7cf2bf4de91`
- Patches avant/après : 140 / 158
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `bf7a5818c1420a634c2cef418273daff90915dd0a5008121b724eb4da3eef507` / `bf7a5818c1420a634c2cef418273daff90915dd0a5008121b724eb4da3eef507`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18659 |
| source_seed | 195 |
| backup | 726 |
| preflight | 131 |
| integrity_before | 579 |
| migration | 626 |
| verify | 229 |
| replay | 128 |
| integrity_after | 1483 |
| negative_gate | 43 |
| rollback | 411 |
| restore | 4057 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
