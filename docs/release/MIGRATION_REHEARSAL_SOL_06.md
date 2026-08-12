# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-12T15:46:57.637Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36199447 octets
- Sauvegarde : 1954319 octets, SHA-256 `97efcd6ac410312fe0ea5d5c61c6cdc4a2a4477e8d3f951e46cb3ae454518eca`
- Patches avant/après : 140 / 147
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `d33b4e782dab383bc42a7a6d32f5b842080fb9e800d2bc27c415598bdfe1f00f` / `d33b4e782dab383bc42a7a6d32f5b842080fb9e800d2bc27c415598bdfe1f00f`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18274 |
| source_seed | 189 |
| backup | 728 |
| preflight | 162 |
| integrity_before | 642 |
| migration | 223 |
| verify | 132 |
| replay | 122 |
| integrity_after | 1342 |
| negative_gate | 40 |
| rollback | 72 |
| restore | 3861 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
