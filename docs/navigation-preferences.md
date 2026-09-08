# Own-account navigation preferences — #770 / frontend #1035

Project Office: `NAV-PERSONAL-20260908`. This implements the user-approved sidebar plan; it changes neither permissions nor shared ERP settings.

## HTTP contract

`GET /api/v1/auth/me/navigation-preferences` and `PUT /api/v1/auth/me/navigation-preferences` require an active authenticated session, including existing MFA/session-epoch checks. Any authenticated role can read/write only its own preferences. The owner comes exclusively from `req.user.id`; ownership fields in the JSON body are rejected and query parameters never select another owner. Responses use `Cache-Control: private, no-store`.

Both methods return a direct JSON configuration, and PUT accepts that same object:

```json
{
  "schemaVersion": 1,
  "side": "left",
  "activeView": "current",
  "views": {
    "current": {"groupOrder": [], "itemOrder": {}, "hiddenGroupIds": [], "hiddenPageKeys": [], "favoritePageKeys": []},
    "global": {"groupOrder": [], "itemOrder": {}, "hiddenGroupIds": [], "hiddenPageKeys": [], "favoritePageKeys": []},
    "production": {"groupOrder": [], "itemOrder": {}, "hiddenGroupIds": [], "hiddenPageKeys": [], "favoritePageKeys": []}
  }
}
```

`side` accepts `left`/`right`; `activeView` accepts `current`/`global`/`production`. `itemOrder` maps stable group identifiers to page-key arrays. Arrays are unique and bounded at 256 IDs, maps at 64 groups, IDs are lower-case alphanumeric/hyphen strings beginning with a letter (80 characters maximum). Objects are strict, the entire JSON payload is limited to 65,536 characters, and malformed bodies receive 400 through the existing Zod handler. Unknown catalogue IDs can be retained for frontend compatibility but never interpreted as routes or permissions.

GET with no row returns the object above without creating data. A database failure propagates as an error; an invalid stored schema returns 503 rather than a default that could overwrite saved settings. PUT is a single parameterized atomic upsert. Concurrent initial saves cannot create duplicate owners; the last successful save wins. No locking token is imposed because this low-impact configuration explicitly uses that policy in the approved plan.

## Persistence and privacy

Additive migration: `db/patches/20260908_user_navigation_preferences.sql`, with preflight, verify and non-destructive rollback instructions under `support/`. `user_id` is the primary key and references `users(id)` with account-deletion cascade. `preferences` is JSONB with object/version/size constraints; `updated_at` is server-generated. Run separately in `cerp_test` and `cerp_prod`; no cross-database lookup exists. This table contains no credentials, labels or business records. Account deletion removes the personal settings; ordinary release rollback retains them.

Use the existing host-side backup/peer-auth migration procedure, test first. After application as postgres, verify the `cerp_app` privileges and set ownership consistently with the existing application tables. Register the normalized-LF SHA-256 in `cerp_schema_migrations`. Restore the previous API/frontend artefacts to roll back; no DROP or preference deletion is needed.

## Validation

`src/__tests__/navigation-preferences.test.ts` exercises the actual routes, JWT middleware, validation and repository queries with deterministic DB fixtures: operator access, missing/inactive sessions, two owners, two sessions, owner injection, malformed shapes, last-writer policy and database/schema errors. Live SQL preflight/verify checks the deployed table and application privileges. Frontend tests cover cache account/database partitioning, stale responses, old/new catalogue entries and UI behaviour. Authenticated live-account smoke requires a normal login; no token is forged from server credentials.
