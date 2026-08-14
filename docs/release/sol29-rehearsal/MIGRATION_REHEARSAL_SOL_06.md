# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-14T20:28:01.009Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36355095 octets
- Sauvegarde : 1968419 octets, SHA-256 `5c6e0651dc6394966dd19f9f6a1242123f7323120fb4076d4ea8b36da37b3bf3`
- Patches avant/après : 140 / 160
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `225a42078d5f067edf34f7e50bc1ac7a0cfd23abf8666cbfece0d1adcb601168` / `225a42078d5f067edf34f7e50bc1ac7a0cfd23abf8666cbfece0d1adcb601168`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18856 |
| source_seed | 194 |
| backup | 755 |
| preflight | 145 |
| integrity_before | 581 |
| migration | 708 |
| verify | 239 |
| replay | 126 |
| integrity_after | 1563 |
| negative_gate | 42 |
| rollback | 458 |
| restore | 3933 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
