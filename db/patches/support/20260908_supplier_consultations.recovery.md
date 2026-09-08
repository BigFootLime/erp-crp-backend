# Recovery — supplier consultations

The patch is additive and does not alter existing purchase quantities, suppliers,
allocations or offers. Apply only after backup and preflight, then verify under
`cerp_app`. Record the exact SHA-256 through the existing patch runner.

To stop new use, disable the material rollout or roll the test API back to the
preceding reviewed release. Keep all four tables, command receipts and history.
Do not delete a selected offer or restore an old purchase draft independently:
selection explicitly updates the canonical purchase, so a business correction
must preserve its audit, supplier choice, quantities, allocations and later AR.
No mail has been sent by this module.
