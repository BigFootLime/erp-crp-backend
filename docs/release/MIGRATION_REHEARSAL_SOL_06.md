# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-11T12:50:35.056Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36199447 octets
- Sauvegarde : 1954302 octets, SHA-256 `cfb03d3edfacf61fc8bbf63c218aee069a443c38a094e1c766b8ba9cd1d73d58`
- Patches avant/après : 140 / 145
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `ed3d10df6ba7c504198adf1892a5380425537598d84751db416355285314c9b3` / `ed3d10df6ba7c504198adf1892a5380425537598d84751db416355285314c9b3`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19039 |
| source_seed | 197 |
| backup | 744 |
| preflight | 174 |
| integrity_before | 609 |
| migration | 219 |
| verify | 123 |
| replay | 164 |
| integrity_after | 1364 |
| negative_gate | 41 |
| rollback | 23 |
| restore | 4160 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
