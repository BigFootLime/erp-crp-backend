# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T04:49:35.668Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968404 octets, SHA-256 `60bdbca8744707751f9888705711ba1f8e7a9fc832b281a7ebc0aec06c6f5909`
- Patches avant/après : 140 / 154
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `15817807200ec885da9cfab50277497674edd0f4b81e6c406a3e21325820771c` / `15817807200ec885da9cfab50277497674edd0f4b81e6c406a3e21325820771c`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18356 |
| source_seed | 193 |
| backup | 726 |
| preflight | 119 |
| integrity_before | 586 |
| migration | 457 |
| verify | 195 |
| replay | 119 |
| integrity_after | 1401 |
| negative_gate | 41 |
| rollback | 248 |
| restore | 3997 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
