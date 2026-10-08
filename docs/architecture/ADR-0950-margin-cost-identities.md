# Cost identity collisions in industrial margins

WP-278 / backend #950. Status: implemented; combined business acceptance deferred by Keenan's explicit instruction.

The assembler concatenated automatic and versioned manual costs. The calculator summed every row, including duplicate economic keys. Historical quote keys also lacked the commercial-line prefix, and approved invoice reconciliation retires the original supplier receipt keys. These are code-level defects; no production collision occurrence is established.

Keep the original amounts, quantities and source lineage inspectable. Mark ambiguous cost rows with COST_SOURCE_COLLISION, remove their amounts from resolved/partial totals, and expose a missing input instead of choosing an arbitrary winner. Exact key collisions are guarded inside the calculator too. Legacy purchase/operation keys overlapping current quote-line sources make both sides unresolved; no allocation to a commercial line is guessed. Manual receipt costs whose automatic identity was retired by invoice reconciliation become unresolved without displacing the approved financial source. An explicit NOT_APPLICABLE successor can retire that obsolete manual entry. Distinct supplemental identities remain additive.

Formula revision 2.0.1 retains the numerical formula and adds identity eligibility checks. Stored input revisions and quote captures are never modified in place; reading/capturing inputs uses the guards. No financial posting, stock valuation, invoice approval, pricing, customer PDF or authorization change. This does not infer semantic duplication between arbitrary independently named manual sources.

Validation: strict TypeScript and build; no SQL changed. Prepared acceptance covers exact identity collisions, multiline quote aliases, approved invoice plus retired manual receipt, explicit retirement and independent costs. Execute these cases with the complete final recipe, not during this increment.
