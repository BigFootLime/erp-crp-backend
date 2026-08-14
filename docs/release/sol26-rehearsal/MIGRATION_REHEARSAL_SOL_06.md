# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T13:43:16.410Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968431 octets, SHA-256 `c855461f48d5118137dc9d1a1493298f92998a367c568c8404bbe3c4a4ad9501`
- Patches avant/après : 140 / 157
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `9c0e994251c8898b13f9fb106c7675a1fdccd5b98cb5f1a436cf9c2a409b97dc` / `9c0e994251c8898b13f9fb106c7675a1fdccd5b98cb5f1a436cf9c2a409b97dc`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18554 |
| source_seed | 220 |
| backup | 766 |
| preflight | 143 |
| integrity_before | 607 |
| migration | 587 |
| verify | 225 |
| replay | 123 |
| integrity_after | 1441 |
| negative_gate | 39 |
| rollback | 333 |
| restore | 4066 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
