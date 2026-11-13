# Customer AR public notes — OBS048 / #1084

The order form appends `[Commande operations]` to its stored comment. New acknowledgement editions now project this storage into public notes and a readable customer requirements paragraph. Operational priority and delimiters are excluded. Ordinary notes, multiline requirements and trailing public notes remain; repeated identical requirements are not duplicated and an incomplete block is omitted.

The projection is made once when creating the official snapshot. Its PDF factory uses the same public text. Raw order data and its fingerprint remain unchanged, as do authorisation, send claims, idempotency and database schema. The archive renderer continues consuming frozen `public_comment` verbatim: this change never updates or reinterprets an existing official edition.

Local validation: 26 tests in four files passed, including an actual PDF generated through the new-edition service and a PDF rendered from a historical snapshot. Frozen strict build and runtime replay are still pending; full industrial acceptance remains in progress.

```powershell
node node_modules/vitest/vitest.mjs run src/module/commande-client/domain/commande-public-comment.test.ts src/module/commande-client/services/commande-ar.service.test.ts src/module/commande-client/domain/commande-ar-fingerprint.test.ts src/module/commande-client/repository/commande-ar.repository.test.ts
```

Runtime replay after publication: explicitly reissue a fixture AR on `cerp_test`; confirm public notes and customer constraints, no storage markers or priority, and preservation of the previous edition. Do not send an email to real recipients for this check. Record the new archive reference and both preview screenshots.
