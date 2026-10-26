# Admin-controlled team group chat

Additive module. No existing users/leads/branches are changed or migrated.
New MongoDB collections: `chatgroups`, `chatmessages` (Mongoose model defaults).

Authenticated endpoints under `/api/v1/chat`:

- GET `/groups`: own/assigned groups only, revalidated against active owner and current branch access.
- GET `/candidates?search=`: Admin/Head only; active employees/managers within Admin branches; at most 200 results, search to narrow.
- POST `/groups`: `{name, memberIds}`; Admin/Head only, owner included automatically.
- PUT `/groups/:groupId`: `{name, memberIds, version}`; owning Admin/Head only; version prevents overwriting concurrent edits.
- GET `/groups/:groupId/members`: owning Admin/Head only.
- GET `/groups/:groupId/messages?before=<messageId>`: membership and live branch scope required; 50 messages per page.
- POST `/groups/:groupId/messages`: `{text, clientId: UUID}`; authenticated sender, max 4000 characters, 30 sends/minute/user, unique idempotency index.

Head can create/manage its own groups; it does NOT gain automatic access to another Admin's messages.
Managers/employees cannot create groups, self-join, manage members, or discover unrelated groups.
Removing membership revokes subsequent API reads/sends. Prior reads/in-flight responses cannot be recalled. UI checks messages every 10s and groups every 15s; history browsing pauses polling until Back to latest. This is polling-based messaging, not WebSockets, and does not rely on the existing notification socket implementation.

Validation: `npm run build && node --test tests/chat.test.mjs`. Route tests use isolated in-memory model doubles, not production MongoDB. Live/staging database and two-account browser acceptance still required.

Release backend FIRST on its existing host with its existing MongoDB/JWT configuration. Verify indexes exist, especially `(groupId, senderId, clientId)` unique, without dropping/rebuilding existing collections. No new credentials are needed. Verify unauthorized 401, unrelated group 404, authorized send/read, reload persistence, membership removal, inactive owner and branch reassignment. Then release frontend `/chat`. Do not replace existing frontend production source with this repository's older main branch: preserve/reconcile the already-deployed SaaS page first.
