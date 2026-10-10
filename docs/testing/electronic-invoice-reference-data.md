# Invoice catalogue response compatibility — OBS059

## Observed failure

On Base Test, the shipped fictitious delivery BL-00000048 is eligible for invoicing,
but the invoice workflow displays `Référentiel BT-23 indisponible` and cannot preview
a draft. The HTTP response succeeds, then the published web response schema rejects
`billing_frame_codes`: the controller sends strings instead of the required objects.

The affected consumer is
`src/modules/facturation/schemas/facture-workflow.schema.ts` in the frontend repository.
Its existing wire contract requires `code`, `operationCategory` and `labelFr` for
each billing frame. The same published frontend is used by the Electron shell.

## Change and constraints

The read controller projects the existing qualified domain catalogue into those
objects. Code order, catalogue version, allowed categories and transaction scopes
are preserved. Labels and the code/category relationship come from the server
catalogue; no client-invented category or guessed legal qualification is introduced.

Finance authentication and read capability checks are unchanged. This endpoint
does not query the external electronic-address directory or write database rows.
No migration, issuer configuration, credential or provider activation is included.

## Verification

```sh
node node_modules/vitest/vitest.mjs run src/__tests__/electronic-invoice-reference-data.test.ts src/module/facturation/electronic-invoicing/electronic-invoice-regulatory.domain.test.ts
```

The route test exercises the real Express router, Finance authorization middleware
and controller. External directory operations are mocked and checked unused; JWT
signature verification and global account-module access are outside this fixture.

Before correction, two compatibility checks fail and two authorization refusals
pass. After correction, the HTTP response must parse through the deployed web
contract, expose all thirteen qualified code/category/label records, remain readable
by the existing technical-administrator role, and reject anonymous or unauthorized
callers. The existing domain checks preserve invalid code/category refusals.

After deployment, use the existing Base Test BL source and `Réessayer` in the web
workflow. Confirm that catalogue choices load in both themes. A missing active
Finance policy, legal sequence, issuer identity or verified electronic address is
a separate prerequisite: document it and do not weaken its validation to issue
an invoice. No email or external electronic-invoice submission is part of this replay.
