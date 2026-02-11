# INSTRUCTIONS_BACKEND.md

Repo-specific instructions for automated coding agents working on the **erp-crp-backend** (CRP SYSTEMS backend).

## 1) Audience, Language, Non-Goals

- **Audience**: automated coding agents (and humans) editing this backend repo.
- **Language**: write instructions and code comments in **English** unless the surrounding file is already French.
- **Domain terminology**: preserve existing French domain names and module slugs (examples: `client`, `commande-client`, `outils`, `pieces-techniques`, `centre-frais`). Do not rename them.
- **Non-goals**:
  - No refactors “for cleanliness” while implementing unrelated changes.
  - No dependency changes, no architecture changes, no API-wide response-shape rewrites.
  - Never read/print/commit secrets (especially `.env` content).

## 2) Scope

- This repo is a Node.js/TypeScript Express backend with:
  - HTTP API under `/api/v1`.
  - PostgreSQL access via `pg` with hand-written SQL.
  - JWT auth (Bearer token) for selected routes.
  - Static file serving for `uploads/images` (and module-specific multipart handling in `commande-client`).
  - Socket.IO server initialization.

## 3) Tech Stack (Observed)

Observed from `package.json`, `tsconfig.json`, and code:

- Runtime: Node.js (Docker base image `node:20-alpine` in `Dockerfile`)
- Language: TypeScript (`typescript`), strict mode enabled (`tsconfig.json`)
- HTTP: Express (`express`)
- Validation: Zod (`zod`)
- Database: PostgreSQL via `pg` (`src/config/database.ts`)
- Auth: JWT via `jsonwebtoken` (Bearer header)
- Security/HTTP middleware: `helmet`, `cors`, `morgan`
- Uploads: `multer`
- Docs: `swagger-ui-express`, `swagger-jsdoc` (dev), and `@scalar/express-api-reference`; OpenAPI spec in `src/swagger/swagger.ts`
- WebSocket: `socket.io` (`src/sockets/sockeServer.ts`)
- Tests: Vitest (`vitest`) + Supertest (`supertest`) under `src/__tests__`
- Dev runner: `ts-node-dev` (`npm run dev`)

## 4) Local Dev / Build Commands

From `package.json`:

- Install: `npm ci` (recommended for CI parity) or `npm install`
- Dev: `npm run dev` (runs `ts-node-dev --respawn --transpile-only src/index.ts`)
- Build: `npm run build` (runs `tsc -p tsconfig.json`, outputs `dist/`)
- Start (built): `npm start` (runs `node dist/index.js`)
- Tests:
  - `npm test` (vitest)
  - `npm run test:run` (vitest run)
  - `npm run test:ui` (vitest UI)

Notes:

- No explicit `lint` script/config was found at repo root.
- `npm run dev` is `--transpile-only` and will not typecheck; use `npm run build` for strict TS verification.

## 5) Commit Message Convention

- **Commit convention is configured** via `.cz.toml` at repo root (Commitizen config).
- Message format (from `.cz.toml`):
  - Template: `<type>: <description>`
  - Regex: `^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|security|initialise)(\(.*\))?: .+`
- Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `security`, `initialise`.

Practical guidance:

- If you use Commitizen locally, use `cz commit` (or `cz c`) so prompts follow `.cz.toml`.
- If you do not use Commitizen, still write commits that match the schema above.
- No `commitlint` config was found.

## 6) Environment Variables

Never commit `.env`. Do not paste env values into issues/PRs/logs.

Env var names observed in code (names only):

- `PORT` (HTTP listen port) in `src/index.ts`
- `NODE_ENV` (environment switch) in:
  - `src/config/app.ts` (static images path selection)
  - `src/middlewares/upload.ts` (upload destination selection)
  - `src/utils/checkNetworkDrive.ts` (network path checks)
- `DATABASE_URL` (PostgreSQL connection string) in `src/config/database.ts`
- `JWT_SECRET` (JWT signing/verifying secret) in:
  - `src/module/auth/middlewares/auth.middleware.ts`
  - `src/module/auth/services/auth.service.ts`
- `BACKEND_URL` (base URL used to build public image URLs) in `src/module/outils/repository/outil.repository.ts`

CI/deploy note (not runtime env, but present as GitHub secrets): `.github/workflows/deploy.yml` references `VPS_HOST`, `VPS_USER`, `SSH_PRIVATE_KEY`, `VPS_PATH`.

## 7) Project Structure (Conventions)

Key entrypoints and wiring:

- HTTP entrypoint: `src/index.ts`
- Express app initialization: `src/config/app.ts`
- API v1 router aggregation: `src/routes/v1.routes.ts`
- Socket.IO init: `src/sockets/sockeServer.ts`
- OpenAPI spec: `src/swagger/swagger.ts`

High-level layout:

- `src/config/` app + database configuration
- `src/routes/` top-level routers (v1 aggregator)
- `src/module/<domain>/` domain modules
- `src/middlewares/` shared/global middlewares
- `src/utils/` shared helpers (errors, async handler, request metadata)
- `src/__tests__/` Vitest tests
- `uploads/` runtime/static assets (also served via `/images`)

Module layout (typical):

- `src/module/<domain>/routes/<domain>.routes.ts` (Express router)
- `src/module/<domain>/controllers/<domain>.controller.ts` (HTTP handlers)
- `src/module/<domain>/services/<domain>.service.ts` (business logic)
- `src/module/<domain>/repository/<domain>.repository.ts` (SQL/data access)
- `src/module/<domain>/validators/<domain>.validators.ts` (Zod schemas + optional `validate(...)` middleware)
- `src/module/<domain>/types/<domain>.types.ts` (domain types/DTOs)

Observed examples (keep these slugs/names):

- `src/module/client/...`
- `src/module/commande-client/...`
- `src/module/outils/...`
- `src/module/pieces-techniques/...`
- `src/module/centre-frais/...`

How to add a new module (recipe)

1. Create: `src/module/<new-domain>/`.
2. Add types: `src/module/<new-domain>/types/<new-domain>.types.ts`.
3. Add validators:
   - `src/module/<new-domain>/validators/<new-domain>.validators.ts` with Zod schemas.
   - If the module uses middleware-style validation, export a `validate(schema)` like in `src/module/pieces-techniques/validators/pieces-techniques.validators.ts`.
4. Add repository: `src/module/<new-domain>/repository/<new-domain>.repository.ts` using `src/config/database.ts`.
5. Add service: `src/module/<new-domain>/services/<new-domain>.service.ts`.
6. Add controller: `src/module/<new-domain>/controllers/<new-domain>.controller.ts`.
7. Add routes: `src/module/<new-domain>/routes/<new-domain>.routes.ts` and wire validators + controller.
8. Register routes in `src/routes/v1.routes.ts` (import + `router.use("/<path>", newRoutes)`).
9. If endpoint should appear in docs, update `src/swagger/swagger.ts`.
10. Add/extend tests under `src/__tests__/` and run `npm run test:run`.

## 8) Request/Response + Validation Pattern

Request parsing (global):

- `src/config/app.ts` conditionally applies JSON parsing only when `Content-Type` is `application/json`.
- `src/config/app.ts` always applies `express.urlencoded(...)` for `application/x-www-form-urlencoded`.
- For multipart endpoints, modules use `multer` at the route level (example: `src/module/commande-client/routes/commande-client.routes.ts`).

Validation (observed patterns):

- **Controller-level Zod parse**: controllers call `schema.parse(req.body)` (example: `src/module/auth/controllers/auth.controller.ts`, `src/module/client/controllers/client.controller.ts`). Zod errors are formatted by `src/module/auth/middlewares/validationError.middleware.ts` (wired in `src/config/app.ts`).
- **Route middleware validate(...)**: some modules wrap inputs as `{ body, params, query }` and use a local `validate(schema)` with `safeParse` returning `400 { error: <message> }` (example: `src/module/pieces-techniques/validators/pieces-techniques.validators.ts`).
- **Shared validateBody middleware** exists at `src/middlewares/validate.ts` (uses `HttpError` + `next(...)`), but it is not the primary pattern across modules.

DTO/type location:

- Zod-derived DTOs live next to schemas via `z.infer<...>` (examples: `src/module/auth/validators/auth.validator.ts`, `src/module/client/validators/client.validators.ts`).
- Some modules also define domain types in `src/module/<domain>/types/*.types.ts`.

Response conventions (observed):

- Create endpoints often return `201` with JSON body (example: `src/module/auth/controllers/auth.controller.ts`).
- Updates frequently return `204` with no body (example: `src/module/client/controllers/client.controller.ts`).
- Listing endpoints return `200` with arrays/objects.

## 9) Error Handling & Logging Pattern

Wiring order (in `src/config/app.ts`):

- `src/module/auth/middlewares/validationError.middleware.ts` is attached before the final error handler.
- Final error handler is `src/middlewares/errorHandler.ts` and must remain last.

Observed error response shapes (do not change globally without an explicit task):

- `src/middlewares/errorHandler.ts` returns `{ success: false, message, code, path }` and logs detailed server-side info (status, code, details, stack).
- `src/module/auth/middlewares/validationError.middleware.ts` returns `400` with `{ error: "VALIDATION_ERROR", message, errors: [{ field, message }] }`.
- `src/middlewares/error.middleware.ts` exists for `ApiError`, but is not wired in `src/config/app.ts` (treat as unused unless you explicitly wire it as part of a scoped task).

Logging (observed):

- HTTP request logging uses `morgan("dev")` in `src/config/app.ts`.
- `src/utils/logger.ts` exists (console wrappers) but is not a required pattern.

Logging rules:

- Never log credentials (passwords), JWTs, `DATABASE_URL`, or raw Authorization headers.
- Prefer high-level, non-sensitive context (path, method, status, request id if added later).

## 10) Auth & Security Pattern (Observed)

JWT auth:

- Middleware: `src/module/auth/middlewares/auth.middleware.ts`
  - Reads `Authorization: Bearer <token>`
  - Verifies via `process.env.JWT_SECRET`
  - Attaches `req.user` (payload contains `id`, `username`, `email`, `role`)

RBAC:

- `authorizeRole(...roles)` in `src/module/auth/middlewares/auth.middleware.ts`
- Example route protection: `src/module/auth/routes/auth.routes.ts` (`GET /me` uses `authenticateToken` + `authorizeRole(...)`).

Token issuance:

- `src/module/auth/services/auth.service.ts` issues JWT with `expiresIn: "1d"`.
- Password hashing uses `bcryptjs` (`bcrypt.compare`, `bcrypt.hash`).

Security guard rails:

- Do not weaken auth checks, do not accept tokens from query params, and do not bypass RBAC.
- Keep `helmet()` enabled (wired in `src/config/app.ts`).

## 11) Database / SQL / Uploads Pattern (Observed)

Database:

- Pool is created in `src/config/database.ts` using `process.env.DATABASE_URL`.
- Repositories/services use `pool.query(...)` or `pool.connect()` for transactions.
- Transaction pattern: `BEGIN` / `COMMIT` / `ROLLBACK` with `finally { client.release() }` (example: `src/module/client/repository/client.repository.ts`).

SQL/migrations:

- No `migrations/` directory and no `*.sql` files were found in this repo at the time of writing.
- Treat schema changes as out-of-band unless a task explicitly adds a migration system.

Uploads + static files:

- Static images are served at `/images` in `src/config/app.ts` from:
  - local: `uploads/images` (when `NODE_ENV === "development"`)
  - prod/network path: hard-coded Linux path (also used in `src/middlewares/upload.ts` and `src/utils/checkNetworkDrive.ts`)
- Shared multer config exists in `src/middlewares/upload.ts` (writes to `uploads/images` or the network path).
- `commande-client` documents upload uses route-local multer dest `uploads/docs` in `src/module/commande-client/routes/commande-client.routes.ts`.

## 12) API Routing Conventions

- API base prefix: `src/config/app.ts` mounts `src/routes/v1.routes.ts` at `/api/v1/`.
- `src/routes/v1.routes.ts` registers modules with `router.use(...)`.
  - Example: `router.use("/auth", authRoutes)` mounts `src/module/auth/routes/auth.routes.ts`.
  - Note: module slug and URL prefix may differ (example: `src/module/commande-client` is mounted at `/commandes`).

Conventions:

- Keep `routes/*.routes.ts` thin: middleware (auth/validation/upload) + controller.
- Prefer `validators/*.validators.ts` for Zod schemas; do not validate ad-hoc in repositories.
- Do not change the global middleware order in `src/config/app.ts` without a dedicated task.

## 13) Testing

- Test runner: Vitest (`vitest`) with Supertest (`supertest`).
- Tests live in `src/__tests__/` (example: `src/__tests__/app.test.ts`).
- Commands: `npm test` or `npm run test:run`.

Observed conventions:

- HTTP tests import the Express app from `src/config/app.ts` and call endpoints via Supertest.
- Tests frequently mock modules/middlewares using `vi.mock(...)` (example: `src/__tests__/auth.routes.test.ts`).
- DB config tests mock `pg` and set env vars in-test (example: `src/__tests__/db.test.ts`).

## 14) Editing Safety Checklist (Agent)

DO:

- Follow the module folder structure under `src/module/<domain>/`.
- Preserve French domain terms and existing route prefixes.
- Add validation via Zod using the module’s existing pattern (controller `parse` vs route `validate`).
- Keep database access in `repository/` and business logic in `services/`.
- Keep `src/config/app.ts` middleware order intact.

DON'T:

- Do not log secrets (Authorization header, JWT, passwords, `DATABASE_URL`).
- Do not bypass auth or validation to “make tests pass”.
- Do not introduce new error response shapes across the whole API.
- Do not add new dependencies or a migration system unless explicitly requested.
- Do not read or paste `.env` contents; never commit `.env`.

## 15) Verification

After making code changes, run:

- `npm run build`
- `npm run test:run`

Targeted checks (when relevant):

- If you touch `src/config/app.ts`, run `src/__tests__/app.test.ts` (via `npm run test:run`).
- If you touch auth (`src/module/auth/...`), run auth tests (via `npm run test:run`).
- If you touch DB wiring (`src/config/database.ts`), run `src/__tests__/db.test.ts`.
- If you touch uploads/static file serving, smoke-check `/images` behavior (local `uploads/images`).

## 16) STOP CONDITION (VERY IMPORTANT)

Stop once ALL are true:

1. The requested change is implemented (no extra refactors).
2. `npm run build` succeeds once.
3. `npm run test:run` succeeds once.
4. App boots once without throwing at startup (for example `npm run dev` starts and `GET /` returns 200).
