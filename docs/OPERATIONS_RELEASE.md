# CRM operations workspace

This branch adds non-advertising CRM improvements. It does not change authentication, rate limiting, dialer credentials, budgets or production hosting. The frontend companion branch is `feature/crm-operations` in Dealquix-crm-frontend.

## Implemented

| Requested area        | Implementation                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow-up reminders   | Once-per-follow-up in-app notification when due; management escalation after 30 minutes. Minute sweep plus existing notification polling; no external messages. Current owner and branch must still match.                        |
| Duplicate control     | Paginated review of exact stored country/phone duplicates within each branch. Existing create-time duplicate checks remain; no automatic merging or destructive cleanup.                                                          |
| Auto assignment       | Management-triggered batch of up to 100 oldest unassigned `new` leads within one active branch. Least current open-lead load across active employee accounts with eligible employment profiles. Existing owners are not replaced. |
| Calling report        | Rolling 7–90 day frontend filters; API supports 1–365 days. Per employee calls, connected calls with positive recorded duration, talk time, created leads and current converted status.                                           |
| WhatsApp              | Reuses existing lead conversation history, approved template APIs and WATI connection. No new external sends are triggered by this branch.                                                                                        |
| Team performance      | New call/lead summary links to existing Performance module for targets and revenue. It does not invent registration/deposit milestones absent from this CRM's current status model.                                               |
| Lead history          | Paginated existing LeadActivity records, guarded by the lead's current visibility and activity-view permission.                                                                                                                   |
| Old lead reactivation | Paginated open leads with no recent lead edits, lead activity, calls or WhatsApp messages. Assigned employee can schedule a future callback using the existing follow-up service. No automatic broadcast.                         |
| Support tickets       | Branch-bound lead-linked tickets; management assignment, status, comments and history. Employees see tickets they created. Updates require an optimistic version; history is capped at 500 events.                                |
| Mobile improvements   | Workspace uses responsive cards, touch-sized controls, click-to-call and existing lead WhatsApp links. This is not a redesign of every legacy CRM page or a new APK release.                                                      |

## Access and deployment

- No AWS SDK or AWS credentials added. Existing MongoDB and application hosting are required.
- All APIs require CRM authentication and lead-view permission. Reporting, history, follow-ups and distribution also require their existing permissions. Non-Head users are branch-scoped; employee lead queries are additionally owner-scoped. Empty branch membership fails closed.
- Auto assignment needs MongoDB transactions (replica set or sharded cluster). Conditional claims avoid double assignment. The transaction includes both assignment history and lead activity. Concurrent batches can use slightly stale load counts; they do not share an exact global round-robin cursor.
- Server startup creates a sparse unique `Notification.dedupeKey` index before starting reminders. The database account must allow index creation. Existing notifications are unaffected because they have no dedupe key.
- Reminder delivery is idempotent through the unique key. Existing outstanding follow-ups are eligible after rollout, processed in bounded batches of 100 per stage each minute.
- Tickets are a new collection with no migration of existing leads. Employee-created tickets remain branch-bound even if the source lead later moves.
- Backend connector access was added and branch creation verified on 5 November 2026. Changes are being saved for review; no live deployment has been completed.

## Validation

Run `npm run build` and `node --test tests/operations.test.mjs` from the backend. The six tests cover branch and owner isolation, validation, allocation fairness, real Express route auth/permission behavior, transactional assignment orchestration and idempotent reminder writes. Database calls are mocked: actual transaction rollback, index behavior, production volume, live WATI/Stringee data and delivery must still be tested in staging.

The companion frontend passed TypeScript/Vite production build and targeted ESLint. No browser executable was available in this environment; real phone/browser usability and end-to-end live integration remain release gates.

## Remaining expansion

- Always-on incoming-lead distribution rules (the current implementation is an explicit batch).
- Stronger phone normalization and atomic duplicate prevention across every import/provider path; safe human-reviewed merge workflow.
- Follow-up deduplication under simultaneous callback creation; current existing service allows multiple pending follow-ups if requests race.
- Full legacy-page mobile QA and APK distribution after a real-device dialer test.
- Existing backend rate-limit/proxy fix remains a separate pending release; this branch does not resolve 429 errors.
