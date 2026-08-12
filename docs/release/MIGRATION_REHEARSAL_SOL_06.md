# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-12T20:33:32.002Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36199447 octets
- Sauvegarde : 1954339 octets, SHA-256 `ac0e6f9884f6296c408af4cc0146f322f99501afb80a1e823c637f9dfc4cfd82`
- Patches avant/après : 140 / 148
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `95604517cb6cd91ff263ce0dce1ffeabd091c7fa45e9151c6f7c09761a635f09` / `95604517cb6cd91ff263ce0dce1ffeabd091c7fa45e9151c6f7c09761a635f09`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19319 |
| source_seed | 221 |
| backup | 762 |
| preflight | 147 |
| integrity_before | 649 |
| migration | 277 |
| verify | 146 |
| replay | 140 |
| integrity_after | 1491 |
| negative_gate | 41 |
| rollback | 110 |
| restore | 4233 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
