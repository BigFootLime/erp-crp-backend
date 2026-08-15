# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T23:35:08.257Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968402 octets, SHA-256 `3bce4d50b8383a1c0903885dc7143dae47492b34dd4fa32375c7d237feddb8e9`
- Patches avant/après : 140 / 161
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `571b3c86ead55da65df5c337d5e6d7176e9de6a207c7b23c60b765ee4c912c47` / `571b3c86ead55da65df5c337d5e6d7176e9de6a207c7b23c60b765ee4c912c47`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19474 |
| source_seed | 207 |
| backup | 800 |
| preflight | 150 |
| integrity_before | 616 |
| migration | 816 |
| verify | 249 |
| replay | 122 |
| integrity_after | 1591 |
| negative_gate | 47 |
| rollback | 483 |
| restore | 4144 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
