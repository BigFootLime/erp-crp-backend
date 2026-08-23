# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-23T15:05:59.944Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36363287 octets
- Sauvegarde : 1968541 octets, SHA-256 `a3669cc1ba2253b9a7ce2ed72e636203d7b77bf0d482e1faaf2ee6b5b9473fd7`
- Patches avant/après : 140 / 172
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `e34dff916e151737929bb43238ab161a15aac4b83cde4777ae2ab727dd1a4cf0` / `e34dff916e151737929bb43238ab161a15aac4b83cde4777ae2ab727dd1a4cf0`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 17921 |
| source_seed | 188 |
| backup | 702 |
| preflight | 172 |
| integrity_before | 555 |
| migration | 904 |
| verify | 340 |
| replay | 121 |
| integrity_after | 1456 |
| negative_gate | 40 |
| rollback | 450 |
| restore | 3847 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
