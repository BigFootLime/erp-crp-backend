# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-15T04:39:15.783Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968432 octets, SHA-256 `1715b92f0dbdcade9019bf3523018d9893a3927dfaaac7a1f1aa352835d8f1ce`
- Patches avant/après : 140 / 162
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `ca12781f9d6271d3cd9c95ac408d7f83c2d96b765aae62fbefaa3a4a636a9b71` / `ca12781f9d6271d3cd9c95ac408d7f83c2d96b765aae62fbefaa3a4a636a9b71`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18133 |
| source_seed | 207 |
| backup | 797 |
| preflight | 159 |
| integrity_before | 589 |
| migration | 771 |
| verify | 254 |
| replay | 129 |
| integrity_after | 1527 |
| negative_gate | 40 |
| rollback | 434 |
| restore | 3935 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
