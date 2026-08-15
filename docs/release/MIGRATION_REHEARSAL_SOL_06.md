# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-15T11:04:33.978Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968430 octets, SHA-256 `1270b357fc646deadc7246bb9276d52415ca60d9d125efe9e14dbff229af0e12`
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
| source_migration | 18720 |
| source_seed | 197 |
| backup | 785 |
| preflight | 192 |
| integrity_before | 623 |
| migration | 906 |
| verify | 280 |
| replay | 169 |
| integrity_after | 1570 |
| negative_gate | 41 |
| rollback | 465 |
| restore | 4118 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
