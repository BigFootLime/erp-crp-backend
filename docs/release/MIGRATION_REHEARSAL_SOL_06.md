# Répétition de migration isolée — SOL-06

- Statut : **passed**
- Exécutée : 2026-08-13T11:30:14.810Z
- PostgreSQL : postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
- Base source : cerp_test, 36166679 octets
- Sauvegarde : 1954052 octets, SHA-256 `7dd8de175577c5d04a1f62cdea190ec53a4b4b5f4b9405ec35ee2a2e1a6c86a4`
- Patches avant/après : 140 / 151
- Intégrité avant/après : passed / passed
- Rejeu du runner : 0 patch (conforme)
- Refus métier négatif : SQLSTATE P2606
- Rollback test-only : passed
- Restauration vers base neuve : passed
- Empreinte source/restaurée : `ffba5ceb693763c901308b56f252bd5e498d8c53e2886ce4b9d76ba39e9bf49c` / `ffba5ceb693763c901308b56f252bd5e498d8c53e2886ce4b9d76ba39e9bf49c`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
| source_migration | 18275 |
| source_seed | 195 |
| backup | 698 |
| preflight | 144 |
| integrity_before | 570 |
| migration | 349 |
| verify | 157 |
| replay | 117 |
| integrity_after | 1467 |
| negative_gate | 42 |
| rollback | 165 |
| restore | 3905 |

La pile PostgreSQL était liée à `127.0.0.1`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
