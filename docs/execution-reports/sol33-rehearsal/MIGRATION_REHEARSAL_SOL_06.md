# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-15T05:42:22.058Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968418 octets, SHA-256 `4e0c8273ae1dba1ba4d179f22dc3209ebc35a3c0d4c81cd5b82880cb90e81fdb`
- Patches avant/après : 140 / 163
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `c62f08e680f4e698da8c87d58de696df435683395019185a77225255308107ab` / `c62f08e680f4e698da8c87d58de696df435683395019185a77225255308107ab`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18202 |
| source_seed | 190 |
| backup | 723 |
| preflight | 161 |
| integrity_before | 578 |
| migration | 808 |
| verify | 257 |
| replay | 116 |
| integrity_after | 1619 |
| negative_gate | 45 |
| rollback | 462 |
| restore | 3936 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
