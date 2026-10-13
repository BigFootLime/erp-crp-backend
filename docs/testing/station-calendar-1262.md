# Station calendar deadlines — #1262 / OBS111

The Test worklist displayed `16/10/2001` for the fictive OF1238 although its calendar deadline remained `2026-10-16` in the manufacturing dossier. The PostgreSQL DATE parser can return a local-midnight Date object. `String(date).slice(0,10)` removed the year and sent a locale day/month string for the browser to reinterpret.

The worklist SELECT now projects `to_char(date_fin_prevue, 'YYYY-MM-DD')`. Its mapper accepts that exact calendar representation or the older driver's local-midnight Date, validates textual dates, and rejects unknown formats instead of guessing a year. A Date object's local calendar day is preserved; `toISOString()` is intentionally avoided because it shifts local midnight to the previous UTC day in positive offsets. Sorting stays chronological for ISO calendar keys. The dossier's server-side JSON date projection already retains ISO dates.

The repository tests cover the actual row mapping; domain cases include leap days, year boundaries, invalid/unknown formats and the older Date object. The real PostgreSQL projection and deployed Atelier/Découpe worklists must also be replayed before the error is closed. No OF date, original promise, schema, permission or mutation route changes.
