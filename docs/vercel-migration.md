# Vercel migration preparation (not a production release)

The existing AWS server stays running. No database copy/reset, DNS change,
frontend API switch, secret transfer, or production deployment has been performed.

## Prepared in this branch

- Vercel Express framework / Fluid Compute configuration. `src/app.ts` already
  imports Express and default-exports the app (native Vercel entrypoint).
- On Vercel (`VERCEL=1`), all `/api/v1` requests, including provider webhooks,
  await a shared, bounded MongoDB connection. Failure returns a sanitized 503;
  concurrent callers share the pending connection and future requests can retry.
- `/healthz` is liveness only. `/api/v1/health` on Vercel passes through the
  connection gate; neither substitutes for authenticated acceptance tests.
- Existing AWS startup remains `npm start` -> `dist/server.js`.
- Both canonical CRM origins and the exact configured `CLIENT_URL` are allowed;
  arbitrary preview origins are NOT allowed. Set a specific staging frontend URL.
- Secret files, dependencies, generated output and logs excluded from uploads.

## Offline verification

Run `npm ci --ignore-scripts`, `npm run build`, then
`node --test tests/chat.test.mjs tests/database.test.mjs`.
Tests use model/driver doubles and local HTTP only; no MongoDB service or real
credentials. They do NOT prove live persistence, Vercel bundling or integration
compatibility.

## Required before a preview connected to data

Use a separate backend Vercel project, not the production frontend project.
Keep preview protected and connect an isolated staging database first. Configure
keys directly in the hosting dashboards; never paste secrets into chat or commit
them. Do not invent replacement keys for existing encrypted records.

| Configuration | Requirement |
| --- | --- |
| `MONGO_URI` | Confirm actual existing database host, TLS, access rules and backups; isolated database for staging |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Preserve existing production values at cutover to avoid invalid sessions |
| `INTEGRATION_ENCRYPTION_KEY` | Preserve original key or the original JWT-derived fallback; changing it can make stored WATI/other tokens unreadable |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Required for existing uploads; preserve account |
| `CLIENT_URL`, `BACKEND_URL` | Explicit correct origins, webhook base and callbacks per environment |
| Node runtime / region | Choose supported Node LTS and region after confirming database location |

## Known release blockers, do not skip

1. Existing Socket.IO server in `app.ts` is not the listener used by
   `server.ts`; rooms also trust handshake user/role. Do not expose/reattach this
   socket as part of migration without authenticated room checks and distributed
   delivery/reconnect verification. Team chat uses authenticated REST polling and
   does not rely on this socket. Existing notification behavior needs testing.
2. In-memory rate-limit stores are per instance, not globally enforced on Vercel.
   Configure and test a shared limiter / platform WAF before production cutover.
   Do not set `trust proxy=true` blindly or trust client-supplied IP headers.
3. Existing media accepts 50 MB and lead imports may exceed the platform request
   cap. A Vercel Function has a 4.5 MB request/response cap, including multipart
   overhead. Direct signed upload/chunked import redesign and acceptance tests
   are required to preserve larger uploads; no feature silently reduced here.
4. Validate login/refresh/logout cookies with the final API origin, role/branch
   permissions, chat membership revocation, chat indexes/idempotency/persistence,
   leads, attendance, reports, media, dialer and provider webhook delivery. Check
   model indexes with no destructive `syncIndexes` or collection drops.
5. Frontend GitHub main does not include the prior directly-uploaded SaaS release.
   Recover and reconcile live frontend source before deploying chat to production.
6. Keep AWS and its database unchanged until tested cutover, monitoring and a
   rollback path exist. Do not stop/terminate the EC2 server during preparation.

Official references: https://vercel.com/docs/frameworks/backend/express and
https://vercel.com/docs/functions/limitations .
