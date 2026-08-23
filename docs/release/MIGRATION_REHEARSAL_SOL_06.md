# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-23T10:02:42.142Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36363287 octets
- Sauvegarde : 1968536 octets, SHA-256 `7bd25c74d6ccad6c35d710670d59a38a42243f339312c9fa50c6529a1206b5af`
- Patches avant/après : 140 / 170
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `d5b753c1cb7873471cd22a411d06836cd840f96a36d714d74136f0b99d5671be` / `d5b753c1cb7873471cd22a411d06836cd840f96a36d714d74136f0b99d5671be`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19427 |
| source_seed | 200 |
| backup | 736 |
| preflight | 157 |
| integrity_before | 596 |
| migration | 953 |
| verify | 329 |
| replay | 142 |
| integrity_after | 1650 |
| negative_gate | 46 |
| rollback | 485 |
| restore | 4076 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
