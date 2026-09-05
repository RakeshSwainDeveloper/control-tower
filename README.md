# Control Tower — Application

Construction Project Management MVP. Docker-first: there is no "install Postgres locally" path.

**Specification lives one level up**, in `../` — `MVP_SCOPE.md`, `MVP_MODULE_MAP.md`,
`MVP_API_SCOPE.md`, `MVP_DATABASE_SCOPE.md`, `MVP_PERMISSION_MATRIX.md`,
`MVP_SCREEN_LIST.md`, `MVP_WORKFLOWS.md`, `MVP_USER_JOURNEYS.md`,
`MVP_IMPLEMENTATION_PLAN.md`, and the stack decisions in `STACK_AND_DOCKER_PLAN.md`.

---

## Quick start

```bash
cp .env.example .env      # then set the secrets, or `make up` generates none — see below
make up                   # build + start everything, wait for health
make test                 # run the suite inside Docker
```

| Service | URL |
|---|---|
| Web | http://localhost:5173 |
| API | http://localhost:3000/api/v1/health |
| MinIO console | http://localhost:9001 |
| Mailpit | http://localhost:8025 |
| Postgres | localhost:5432 |

`make help` lists every target.

---

## Layout

```
apps/
  api/         NestJS · REST · migration CLI · tests
  worker/      BullMQ consumers (partition maintenance, notifications)
  web/         React + Vite
packages/
  contracts/   Zod schemas, 52 permission keys, 13 state classes — shared by api AND web
  db/          Kysely types, SQL migrations, tenant-context helper
infra/
  docker/      Dockerfiles + nginx
  postgres/    extensions + least-privilege roles (init, runs once)
  minio/       bucket bootstrap
```

## Phase status

| Phase | Status |
|---|---|
| **P1 · Foundation** | ✅ **Complete — verified end-to-end 5 Sep 2026, 27 tests passing** |
| **P2 · Tenancy, Identity & Access** | ✅ **Complete** — 13 migrations, 32 routes, 71 tests |
| **P3 · Project Foundation** | ✅ **Complete** — 20 migrations, 45 routes, 80 tests, typecheck clean |
| P4 · Evidence + Sync | next |
| P5 · Core Loop | — |
| P6 · Approval + Issues | — |
| P7 · Web UI | — |
| P8 · Dashboard + Hardening | — |

---

## Things that are load-bearing

These are enforced by tests, not by convention. Breaking one should fail CI.

1. **`org_id` on every org-scoped table**, leading index column, RLS enabled *and forced*.
2. **Tenant context is set once per transaction** via `withTenant()`. Never reconstructed
   per query. The pool must stay transaction-level — session pooling leaks one tenant's
   context into the next request.
3. **Partitions carry their own RLS policy.** They do not inherit the parent's on direct
   access. See migration `0003`.
4. **`audit_log` holds INSERT + SELECT grants only** — no UPDATE, no DELETE, for any role.
5. **`created_by_grant_id` on every record** — the responsibility exercised, not just the
   actor. It cannot be backfilled.
6. Applied migrations are **immutable**; the runner refuses a changed checksum.
7. **No currency value is written anywhere** in the MVP.
8. **`ct_auth` is the only RLS-bypassing role.** It is `NOLOGIN`, owns exactly
   four exact-match resolver functions, and holds column-level grants on nine
   columns. Four tests pin that shape — if the list grows, CI fails and somebody
   has to justify it.
9. **Dev and prod must emit decorator metadata identically.** The dev runner is
   SWC, not tsx, because esbuild drops `design:paramtypes` and NestJS DI then
   fails in dev while working in prod.
10. **A data migration must set tenant context per organization.** `FORCE RLS`
    binds the table owner, so a migration with no context sees zero rows —
    `DELETE` silently matches nothing and `ADD CONSTRAINT` validates against an
    empty set and reports success. See migration `0020`.
11. **Cross-project integrity needs composite FKs.** RLS confines a row to the
    tenant, not to the project, and a tenant has many projects.
12. **`make typecheck` must stay at 0 errors.** It is wired to resolve
    workspace packages to source; if it ever reports hundreds of module errors
    again, it has stopped checking anything.

## Notes for whoever runs this next

- `make up` and `make reset` pass `--renew-anon-volumes`. Without it a dependency change
  is built into the image but the stale `node_modules` volume shadows it, and you debug a
  version mismatch that no longer exists in any file you can see.
- `--wait` is scoped to `api web worker`: `migrate` and `minio-init` are one-shot jobs and
  compose reads their clean exit as a wait failure.
- Workspace packages resolve to TypeScript **source** in dev via the `development` export
  condition (`tsx --conditions=development`), and to `dist` in the production image.
  Vitest uses path aliases instead — overriding `resolve.conditions` globally breaks CJS
  interop for `pg`.
