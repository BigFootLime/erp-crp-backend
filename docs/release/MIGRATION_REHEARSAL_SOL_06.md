# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-10T10:12:03.587Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36199447 octets
- Sauvegarde : 1954131 octets, SHA-256 `b77aefc331f7bcd4c23ed0f1bc69d63cfe6e5d3e57ab5853b521c1a24f69b054`
- Patches avant/après : 139 / 140
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `34a2f805c9ea33c785a7e36f5f5bb8666396dd457823cae8cf7b05ebf762ed79` / `34a2f805c9ea33c785a7e36f5f5bb8666396dd457823cae8cf7b05ebf762ed79`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 19749 |
| source_seed | 209 |
| backup | 742 |
| preflight | 163 |
| integrity_before | 615 |
| migration | 160 |
| verify | 70 |
| replay | 135 |
| integrity_after | 1421 |
| negative_gate | 40 |
| rollback | 22 |
| restore | 4085 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
