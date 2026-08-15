# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-15T11:00:14.666Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968403 octets, SHA-256 `f188eb6ccce1b4bf73d68338140f7f8f6035d50c35bb7600f73c0e9b1c82f405`
- Patches avant/après : 140 / 164
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `36318e3291be6dfdcbad2cdeb6c5fca43dc6b3c8312741ea6bd43ed96e9eaa54` / `36318e3291be6dfdcbad2cdeb6c5fca43dc6b3c8312741ea6bd43ed96e9eaa54`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18897 |
| source_seed | 222 |
| backup | 764 |
| preflight | 183 |
| integrity_before | 636 |
| migration | 892 |
| verify | 299 |
| replay | 166 |
| integrity_after | 1600 |
| negative_gate | 40 |
| rollback | 479 |
| restore | 4076 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
