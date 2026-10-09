# Client contract calls in the canonical order aggregate

Status: implemented; combined business/UI acceptance deferred to the end of the eight-lot delivery by user instruction.

## Problem and decision

Contracts belong to the client dossier. A firm customer request selects an active contract and a subset of its current applicable commercial articles, with a new quantity and requested date for each selected article. The replenishment batch belongs to the contract and is not copied as the quantity requested by the client.

`repoCreateCommande` remains the sole order creator. Its existing upload transaction owns canonical header/lines, file movement, PDF, checkpoints and business workflow. Contract preparation runs before an order number is allocated; the call ledger is inserted after canonical lines resolve, in the same transaction. A failure rolls back all order and call writes using the existing confirmed-rollback upload compensation. COMMIT acknowledgement reconciliation remains canonical.

The additive call header and call-line ledger retain the actor, client, contract version, contract snapshot, initial customer reference/date, actual order/line IDs, article/PT version/unit snapshot, original quantity/date and replenishment batch. There is no duplicate order or stock aggregate. Runtime can read and insert this evidence, but cannot update, delete or truncate it. Database triggers enforce immutability.

## Validation and replay

The parent client and contract are locked in the catalog's consistent order. Client must be active, unblocked and unarchived; contract must belong to that client, be active, match the expected version and cover the actual order date. Every line must select a distinct available contract line and explicitly match its currently applicable article, PT, technical version and canonical unit. Preparatory quote/draft identities are refused. Quantity is positive, bounded to one billion with at most three decimals; calendar dates must be real ISO dates.

Actor/idempotency-key locking serializes duplicate requests. The digest includes the parsed request plus ordered filename, MIME type and SHA256 content digests of uploaded files, never temporary paths. Identical committed requests return the actual existing order ID. A changed request under the same key is refused. Replay throws a private sentinel from inside the upload transaction; it is caught only after confirmed rollback and cleanup of the retry's fresh uploads. Uncertain rollback/cleanup cannot falsely become a successful replay.

## History and subsequent operations

Paginated client-contract history joins immutable snapshots to current canonical quantities/dates. Old indices are never resolved through the current catalog. Order detail exposes its saved contract identity and each canonical line's contract-line binding for subsequent delivery/BL compatibility work. The new BL compatibility implementation remains its own lot (#1030).

Updates retain client, firm type, contract, line count/IDs, article, PT version and unit. Existing order policy still controls when edits are permitted; original snapshots remain unchanged when current quantities/dates change. Deletion and duplication of bound calls are refused. A new request is created explicitly from the current client contract. New standalone `CADRE` orders/duplicates are refused; existing CADRE records and their release endpoints remain unchanged. Historical migration/rebinding is still explicit pending work: there is no inferred contract ownership from reference text.

## Deployment and recovery

Apply `20261009_client_contract_calls_1031.sql` after the client catalog and canonical order reconciliation migration. Preflight verifies actual canonical types and prerequisites; verify checks table privileges, immutable triggers and canonical identity consistency. Rollback support refuses any used ledger and locks both tables before deciding whether an entirely unused schema can be removed. Retain schema and restore a compatible runtime after any actual call is used. Final common acceptance is documented separately and has not been claimed as executed.
