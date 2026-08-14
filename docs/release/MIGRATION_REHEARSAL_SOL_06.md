# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T07:35:34.912Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968391 octets, SHA-256 `a5a0f52a892441d755aae43babfbc0e433696e60172cc337bd2680c71314bf7d`
- Patches avant/après : 140 / 155
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `d00101a59074e6361baa8e0aa947a9322a4b5f536dadd893c9178ce264ecb8a3` / `d00101a59074e6361baa8e0aa947a9322a4b5f536dadd893c9178ce264ecb8a3`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 20094 |
| source_seed | 212 |
| backup | 741 |
| preflight | 135 |
| integrity_before | 657 |
| migration | 522 |
| verify | 225 |
| replay | 127 |
| integrity_after | 1427 |
| negative_gate | 43 |
| rollback | 317 |
| restore | 4067 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
