# Backend Agent Operating Rules

This repository is the backend implementation backup for Croix Rousse Precision ERP/GPAO.

## Required reading before edits

1. `INSTRUCTIONS_BACKEND.md`
2. Canonical Project Office workflow: `../crp-systems-web/docs/ai/AI_PROJECT_OFFICE_WORKFLOW.md`
   ([GitHub fallback](https://github.com/BigFootLime/crp-systems-web/blob/dev/docs/ai/AI_PROJECT_OFFICE_WORKFLOW.md))
3. `docs/frontend_repo_map.md`
4. `db/patches/`
5. impacted route, service, repository, and validator files

## Core rules

- preserve the existing Express + TypeScript + PostgreSQL architecture
- do not weaken auth, RBAC, audit logging, or validation
- do not run destructive database operations without human approval
- do not commit secrets or production data
- keep route, service, repository, validator responsibilities separated

## Current architecture

- entrypoint: `src/index.ts`
- app wiring: `src/config/app.ts`
- route aggregation: `src/routes/v1.routes.ts`
- database access: `src/config/database.ts`
- schema evolution: `db/patches/`

## Priority expectations

- keep API compatibility with the frontend
- document meaningful architecture changes
- prefer additive migrations and reversible changes
