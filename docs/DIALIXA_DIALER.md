# Dialixa calling in DealQix

Stringee call initiation, its public write webhooks and number assignment routes are retired (HTTP 410). Existing call history and historical recording playback remain available. Dialixa starts disabled, both for the account and for every CRM user; existing Stringee assignments are not reused as Dialixa extensions.

## Activate

1. Sign in to DealQix as Head and open **Dialer → Dialixa setup** (`/dialer/numbers`).
2. In the Dialixa Admin Panel, enable **Settings → Click-to-Call API**. Copy the exact production API base URL and complete API key into the DealQix account form, and enable calling.
3. Assign each user's extension from Dialixa **Settings → Users & Roles**, then enable their access. Each extension belongs to one CRM user. Admin can manage their own extension and subordinate Manager/Employee accounts whose entire branch membership is within the Admin's scope.
4. Agents sign in to Dialixa and keep their softphone open and registered. In DealQix, select a lead, confirm the softphone is ready and request the call. Answer the agent softphone first; Dialixa then dials the customer.

The PDF's `https://dev.voxentroconsulting.com` is a development example and is **not** preconfigured as production. HTTPS base URLs under `voxentroconsulting.com` are allowed. For a different confirmed provider hostname, the server administrator must add that exact hostname to `DIALIXA_ALLOWED_API_HOSTS`. Redirects, URL credentials, paths, query strings and non-HTTPS URLs are rejected to avoid forwarding the key to an unintended destination.

API keys are encrypted using the existing AES-GCM secret storage. Use a stable `INTEGRATION_ENCRYPTION_KEY` (32 bytes, base64); if the deployment already derives its encryption key from `JWT_SECRET`, preserve that existing configuration until all saved integration secrets can be migrated together. The plaintext Dialixa key and provider response body are never returned to the browser or logged. Changing the API host requires re-entering its key.

## Request and history behavior

- `GET /api/v1/dialer/session` reports CRM configuration and the authenticated user's extension. It does not claim that the remote softphone is online.
- `POST /api/v1/dialer/click-to-call` accepts a UUID `requestId` and a `leadId`, or a manually entered `number` for management. Browser-supplied extensions are rejected. The server loads the authenticated agent's extension and the scoped lead's name/number.
- Employees can call only leads assigned to them in their branches. Head has global access; Admin and Manager have branch scope. These scopes also apply to call history and individual log records.
- One upstream attempt is allowed per user/request ID. A unique database constraint, atomic per-agent 20-second lease and account-wide 60-per-minute counter protect against duplicate and concurrent submissions across processes. Dialixa's own rate limit remains authoritative.
- A provider HTTP 200 is recorded as **Request sent**, with no connected/answered claim. Explicit provider rejections are recorded as failed. Timeouts, redirects and unexpected statuses remain **Outcome unknown** and are never automatically retried. Requests that were interrupted after reservation remain pending and are also never automatically retried.
- New Dialixa call logs have `provider: "dialixa"`; talk time and recordings show as unavailable. The supplied Click-to-Call API has no call-status, hangup, recording or history endpoints. A separate vendor-supported integration is required to populate those metrics. Existing connected/talk-time statistics continue to rely on actual historical statuses; a request is not counted as answered.
- Extension ownership and call-request deduplication indexes are created before the server starts accepting traffic. No existing call logs or number inventory are deleted.

## Verification

Run `npm run build` and `node --test tests/dialixa.test.mjs` in this repository, plus `npm run build` in the companion frontend. Tests cover authenticated routes, retired endpoints, assignment/branch boundaries, server-derived payloads, all documented HTTP errors, key redaction/encryption, duplicate IDs, concurrency, timeouts and history access. Database calls and the vendor HTTP call are mocked; a real softphone call needs the production account credentials and a configured agent.

Rollback requires reverting both companion commits. Disabling Dialixa in the setup form immediately blocks new CRM requests without deleting assignments or history.
