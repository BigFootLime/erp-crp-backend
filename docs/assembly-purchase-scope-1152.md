# Assembly purchase scope (#1152)

Four AXE components in a new assembly preview counted treatment 4+4+4 and material442+442+440 because purchases ignored their technical version. The reader now uses the selected piece/version pairs and matches the OF snapshot policy: unversioned purchases apply only when that exact version has no purchases. A scoped purchase without an article still suppresses the fallback.

Distinct source lines, component occurrences and BOM behavior remain unchanged; no historical data rewrite, migration, API or security change. Source ordering is deterministic for the supply-plan hash. Isolated PostgreSQL tests execute the real query against focused tables, including obsolete versions, legacy-only pieces, selected pairs and repeated occurrences. They do not qualify the entire production schema or end-to-end recipe.

Actual replay on Base Test CMD-2026-1256 is required before closing OBS087. The combined manufacturing recipe and installed native applications remain in progress.
