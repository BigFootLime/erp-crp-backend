# Material state/process source alignment — #1566

This unpublished CERP 2.0.89 source candidate ports the urgent generator behavior from
`ea3dd7ad9c1b1c6c722dd6e96ebde56fc0f9a569` into the current refactored owners, starting
from dev `8c1eaa45a0dcf5ec97144a319b85c1ec1dc5bb80`. Frontend issue: BigFootLime/crp-systems-web#1923.
The backend package keeps its independent component version.

`resolveMaterialCodeInput` stays in `stock-material-referentials.repository.ts`.
The four state/process combinations feed the same authoritative generator for preview
and creation; null selections do not query a fictitious referential or add code segments.
Selected unknown IDs still fail validation. The historical `sous_etat_id` API/database
field keeps its name; its error label now says Procédé. Nuance, special-profile,
ownership and existing article identity rules remain unchanged.

The dedicated resolver test checks query counts, code/designation consistency and
preview hashes. Generator/HTTP-contract tests remain in `material-article-code-164.test.ts`.
Actual focused test, TypeScript, build and boundary receipts are recorded with their
executed source pair in the workspace qualification output. The urgent 30-test run
and historical full backend campaign are not relabelled as runs on this source port.
Mocked repository resolution is not a PostgreSQL persistence or production test.

This source alignment does not deploy the cleanup, patch a runtime, modify EC,
publish an installer, change permissions or apply a database migration. Existing
2.0.87 qualification and the production 2.0.88 source/artifact variants stay historical.
