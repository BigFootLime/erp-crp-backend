# Manual workstation assignment — #761

Manual recipe #970 exposed a mismatch: technical preparation accepts manual route operations without CNC qualification, but planning rejected all of them.

An operation with frozen type DECOUPE, CONTROLE, LAVAGE, EMBALLAGE or AUTRE, and no machine-family requirement, can use only its explicitly assigned autonomous, active, non-archived workstation. Assignment remains an operational decision through the OF interface. Unknown types and CNC operations keep their existing qualification checks. External treatments remain a separate planning limitation, not disguised as internal work.

The central snapshot and the shared resource invariant used by classic and central commits apply this same rule. No schema or business-data mutation is part of this fix. Existing calendars, conflicts, snapshots, revision and audit checks remain authoritative.

Validation: targeted qualification tests cover the five manual types, wrong/inactive/unassigned/machine-backed postes and preserved CNC/external refusals. Manual acceptance requires creating a poste through the UI, assigning an OF operation and validating a simulation.
