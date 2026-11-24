# Manual workstation assignment — #761

Manual recipe #970 exposed a mismatch: technical preparation accepts manual route operations without CNC qualification, but planning rejected all of them.

An operation with frozen type DECOUPE, CONTROLE, LAVAGE, EMBALLAGE or AUTRE, and no machine-family requirement, can use only its explicitly assigned autonomous, active, non-archived workstation. Assignment remains an operational decision through the OF interface. Unknown types and CNC operations keep their existing qualification checks. External treatments remain a separate planning limitation, not disguised as internal work.

The central snapshot and the shared resource invariant used by classic and central commits apply this same rule. No schema or business-data mutation is part of this fix. Existing calendars, conflicts, snapshots, revision and audit checks remain authoritative.

Validation: targeted qualification tests cover the five manual types, wrong/inactive/unassigned/machine-backed postes and preserved CNC/external refusals. Manual acceptance requires creating a poste through the UI, assigning an OF operation and validating a simulation.

## Working hours in ERP setup

The ERP configuration permission gates `GET /api/v1/admin/onboarding/workstations/hours` and the matching `PUT`. Changes follow the existing MFA step-up and apply to industrial companies. The command takes `hours.start`, `hours.end` (local HH:MM, with end after start) and the latest `expected_updated_at` token from the read. A concurrent change returns 409 and requires reloading.

The setting keeps the existing working-hours JSON shape. It preserves the machine hours and any existing workstation categories. When configuring workstation hours for the first time, the application uses DECOUPE, CONTROLE and ASSEMBLAGE. The hours apply to their usual autonomous stations on the dates open in each station’s calendar. The write and forecast job share one transaction and revision. Saving the existing interval does not add a job.
