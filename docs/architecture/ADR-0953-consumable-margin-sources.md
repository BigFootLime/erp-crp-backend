# OF consumable withdrawal costing

WP-278 / backend #953. Combined acceptance remains deferred by Keenan.

The material ledger includes lot-tracked consumables, which were incorrectly classified MATERIAL. Unbatched consumables have canonical partial WITHDRAW commands and posted stock lines but no lot-based material ledger, so their financial ownership was ignored.

Read every posted PRELEVEMENT_CONSOMMABLE line once as PURCHASE. Require one matching canonical WITHDRAW command, its OF/reservation/article/lot, recorded quantity, unit consumable need and a single stock output line. Do not rely on the reservation's mutable latest-movement pointer. Use the stock line's physical quantity and applied unit cost, preserving currency; no implicit conversion. Missing/incoherent commands or prices remain explicit unknown costs. The price is DECLARED, not verified CUMP. Reversed and compensated outputs are excluded. Global pack depletion has no OF allocation.

Remove consumable lines from both material branches to avoid double counting. Historical quote captures and financial/physical journals remain unchanged. No stock posting, supplier order, CUMP layer or assembly-component consumption is introduced.

Validation: strict TypeScript/build and the two changed SQL source plans under cerp_app in READ ONLY/ROLLBACK. Prepared temporary-table acceptance covers partial tracked/untracked withdrawals, identity/unit mismatches, invalid JSON quantity, duplicate command ownership, missing price, reversal and global stock. The pre-existing source recipe fixture is aligned to the terminal declaration columns added in #944. No business tests executed for this increment.
