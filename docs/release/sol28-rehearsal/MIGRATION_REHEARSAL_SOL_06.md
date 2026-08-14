# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T17:59:01.468Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968426 octets, SHA-256 `4130172a6ac597173eb682161ced69a1c27aea823646a2289037a520133ef596`
- Patches avant/après : 140 / 159
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `896306b8cee79bf3de66057170c8cbe6443c926ad8bd88700d423a3e6893d13d` / `896306b8cee79bf3de66057170c8cbe6443c926ad8bd88700d423a3e6893d13d`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18882 |
| source_seed | 189 |
| backup | 750 |
| preflight | 141 |
| integrity_before | 637 |
| migration | 663 |
| verify | 223 |
| replay | 133 |
| integrity_after | 1455 |
| negative_gate | 41 |
| rollback | 444 |
| restore | 4005 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
