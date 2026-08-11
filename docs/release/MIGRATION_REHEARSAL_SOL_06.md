# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-11T12:05:40.539Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36199447 octets
- Sauvegarde : 1954228 octets, SHA-256 `d758b5290e1c831f98bf1274f64d53fc8d351e7de7aee7bf9f4a52aa253ed5b8`
- Patches avant/après : 140 / 145
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `ed3d10df6ba7c504198adf1892a5380425537598d84751db416355285314c9b3` / `ed3d10df6ba7c504198adf1892a5380425537598d84751db416355285314c9b3`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19566 |
| source_seed | 186 |
| backup | 739 |
| preflight | 133 |
| integrity_before | 596 |
| migration | 175 |
| verify | 117 |
| replay | 126 |
| integrity_after | 1351 |
| negative_gate | 42 |
| rollback | 24 |
| restore | 4094 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
