# db/patches/support

Fichiers **auxiliaires** des migrations `db/patches/` : `*.rollback.sql` et `*.verify.sql`.

Ils sont volontairement dans ce **sous-dossier** pour ne PAS être exécutés par le runner
`db:patches:up`, qui ne lit que `db/patches/*.sql` au premier niveau (`readdirSync` +
filtre `.sql`, sans récursion). Ils sont lancés **manuellement** :

```bash
sudo -u postgres psql -d cerp_test -f db/patches/support/<name>.verify.sql
sudo -u postgres psql -d <db>      -f db/patches/support/<name>.rollback.sql
```
