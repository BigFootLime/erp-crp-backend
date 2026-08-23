# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-23T13:59:03.843Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36363287 octets
- Sauvegarde : 1968552 octets, SHA-256 `91762b69aa2bde844338da441dab92b6ff8c3f18c77198f511d9c30fd5c5fc5d`
- Patches avant/après : 140 / 171
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `2ab61304f8c151509f23cf9a7a9f006178a71ac6759b8dd48082c1ce75dbf680` / `2ab61304f8c151509f23cf9a7a9f006178a71ac6759b8dd48082c1ce75dbf680`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19137 |
| source_seed | 211 |
| backup | 767 |
| preflight | 161 |
| integrity_before | 576 |
| migration | 1001 |
| verify | 337 |
| replay | 126 |
| integrity_after | 1551 |
| negative_gate | 40 |
| rollback | 470 |
| restore | 4079 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
