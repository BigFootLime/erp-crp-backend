# Directory verification revision contract — #1224 / WP285

Normal Base Test UI returned a 400 when qualifying an active customer directory
address. Client and supplier readers expose PostgreSQL text timestamps, whereas
the command accepted only ISO timestamps. Three HTTP regressions reproduce the
failure before the fix. The handler now accepts both explicit-offset wire formats,
preserving fractional seconds, and still rejects invalid dates or missing zones.

The locked repository compares timestamps in PostgreSQL, not JavaScript Date.
An intervening change of one microsecond must refuse the command. Directory lookup,
active-address/identity checks, authorization, audit and replay protection remain.
No schema change or caller-supplied verification date is introduced.

Validation: HTTP contract tests cover PostgreSQL hour/minute offsets and ISO;
repository tests cover lock parameters and stale revisions. A read-only PostgreSQL
probe checks equal instants across offsets and distinguishes adjacent microseconds.
Re-run the deployed normal client verification, then the BL56 invoice workflow.

Recipe data: customer195 was originally synthetic ALPHA /999999998, which has no
public directory entry. On11October it was explicitly renamed as an internal CRP
recipe, using CRP's public identity and invoice address. Its observations document
the transition; historical delivery documents remain untouched. This is a test
data change, not proof that arbitrary invented companies pass directory checks.
Test automatic outbound and production outbound are false; provider mode is
sandbox. Do not transmit the recipe invoice. A local PDF is not provider acceptance.
