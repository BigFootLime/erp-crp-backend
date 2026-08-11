# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-11T12:44:18.150Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36199447 octets
- Sauvegarde : 1954334 octets, SHA-256 `fa9157465fb67e3a9c44b4d4dfd23682af809f440f1650760b44def70e45f283`
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
| source_migration | 19393 |
| source_seed | 206 |
| backup | 827 |
| preflight | 190 |
| integrity_before | 674 |
| migration | 239 |
| verify | 132 |
| replay | 191 |
| integrity_after | 1401 |
| negative_gate | 43 |
| rollback | 22 |
| restore | 4083 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
