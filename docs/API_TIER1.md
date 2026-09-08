# Tier 1 API Contract

Endpoints added or changed by the Tier 1 foundation work
(branch `feature/tier1-foundation`). Everything here is implemented and
verified against the live database.

All endpoints require `Authorization: Bearer <jwt>`. Missing/invalid token
returns `401`/`403` with no body.

Base URL: `/api`

---

## 1. Unified My Work

### `GET /api/my-work`

Returns the caller's active work — kanban tickets and support tickets merged
into one normalized list, grouped into buckets.

**Query params**

| Param | Type | Notes |
|---|---|---|
| `userId` | uuid | Optional. View another user's work. Requires role `CEO`, `TECH_LEAD`, `PM` or `ADMIN`; otherwise `403`. |

**Response `200`**

```json
{
  "user_id": "8a837acc-6c62-4a42-8288-3f40daaea31e",
  "counts": {
    "overdue": 2, "due_today": 0, "this_week": 0,
    "blocked": 1, "awaiting_review": 7, "active": 23
  },
  "buckets": {
    "overdue": [], "due_today": [], "this_week": [],
    "blocked": [], "awaiting_review": [], "sla_risk": [], "active": []
  }
}
```

**Work item shape**

| Field | Notes |
|---|---|
| `id` | uuid of the ticket or support ticket |
| `work_type` | `KANBAN` or `SUPPORT` — drives which detail route to open |
| `title` | |
| `status` | kanban `ticket_status`, support `support_ticket_status` |
| `priority` | `P0`–`P3` for support; `null` for kanban |
| `due_date` | kanban → `end_date`; support → `sla_due_at` |
| `is_owner` | `true` when the user is the accountable owner, `false` when collaborating. Kanban → `owner_user_id`; support → `assigned_dev_id` (the PM is a collaborator). |
| `is_blocked`, `blocked_reason` | |
| `project_id`, `project_name`, `client_name` | |
| `updated_at` | |
| `ticket_key`, `linked_ticket_id` | support items only |
| `sla` | support items only, and only once `migrate_sla_v2` has run — see below |

**`sla` block** (support items only)

| Field | Notes |
|---|---|
| `first_response_pct` | % of the first-response target consumed, in business hours |
| `first_response_due_at` | deadline on the business calendar |
| `first_response_met` | `true` if answered within target |
| `resolution_pct` | % of the resolution target consumed, paused time excluded |
| `resolution_due_at` | deadline, already pushed forward by any completed pauses |
| `breached` | either clock past 100% |
| `is_paused` | ticket currently in `WAITING_FOR_CLIENT` |

> **Degrades gracefully.** Ownership and SLA are fetched in separate, fail-soft
> queries. On a database where `migrate_sla_v2` / `migrate_tier1_ownership` have
> not run, `/api/my-work` still returns `200` with every bucket — `sla` is simply
> absent, `is_owner` is `false`, and `sla_risk` is empty. It never 500s on
> migration order.

**Bucketing rules** — buckets are *independent classifications*, not exclusive.
One item can appear in several (e.g. blocked **and** overdue). `active` contains
everything.

- `overdue` — `due_date` before today
- `due_today` — `due_date` is today
- `this_week` — `due_date` within the next 7 days
- `blocked` — `is_blocked = true`
- `awaiting_review` — kanban `CODE_REVIEW`/`QA`; support `TESTING`/`PENDING_DEPLOYMENT`
- `sla_risk` — support work at ≥80% of either SLA clock and still running. Not
  the same as `overdue`: this is the bucket you can still *act* on, since
  `due_date` bucketing only reacts once a ticket is already late.
- `active` — all non-terminal work

Terminal items are **excluded entirely**: kanban `DONE`, support `COMPLETED`/`CLOSED`,
and anything soft-deleted.

Kanban assignment is resolved via the `ticket_assignments` junction **or** the
legacy `assigned_to_user_id`. Support items match `assigned_dev_id` **or**
`assigned_pm_id`.

---

## 2. Blocker tracking

Available on both ticket types with identical semantics.

### `POST /api/tickets/:id/block`
### `POST /api/support-tickets/:id/block`

**Body**

```json
{ "reason": "Waiting on API keys from client" }
```

`reason` is **required** and must be non-empty — omitting it returns `400`.
The server stamps `blocked_at` and `blocked_by_user_id` from the token.

**Response `200`** — the updated ticket, including `is_blocked: true`,
`blocked_reason`, `blocked_at`, `blocked_by_user_id`.

### `POST /api/tickets/:id/unblock`
### `POST /api/support-tickets/:id/unblock`

No body. Clears all four blocker fields. Returns the updated ticket.

`404` if the ticket does not exist or is soft-deleted.

---

## 3. Support → development linking

### `POST /api/support-tickets/:id/convert`

Creates a **new** dev ticket from a support ticket, inside one transaction.

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `project_id` | uuid | yes | Target dev project |
| `list_id` | uuid | no | Defaults to the project's first list by position |

**Inherited onto the new ticket**

- Title becomes `[SC-YYYYMM-NNNN] <original title>`
- Description = original description + steps to reproduce + a provenance line
- Attachments copied
- `assigned_dev_id` becomes the ticket assignee (and is mirrored into
  `ticket_assignments` so it appears on boards and in My Work)
- `request_type` maps to `ticket_type`:
  `BUG→BUG`, `FEATURE→FEATURE`, everything else → `CHANGE_REQUEST`

**Response `201`**

```json
{ "support_ticket_id": "...", "ticket": { "id": "...", "type": "BUG", "...": "" } }
```

**`409`** if the support ticket already has a `linked_ticket_id` — convert is
one-shot by design:

```json
{ "error": "This support ticket is already linked to a dev ticket",
  "linked_ticket_id": "..." }
```

### `POST /api/support-tickets/:id/link`

Attaches an **existing** dev ticket instead of creating one.

```json
{ "ticket_id": "72cd7268-3999-4dfe-9d36-2ea2f254e91b" }
```

`404` if either ticket is missing or soft-deleted.

---

## 4. Deletion is now soft

### `DELETE /api/tickets/:id`
### `DELETE /api/support-tickets/:id`

**Behaviour change.** These previously hard-deleted the row along with a manual
cascade across comments, checklists, assignments, transitions and credit
evaluations. They now set `deleted_at` and **leave every related record intact**.

**Body** (optional but recommended)

```json
{ "reason": "duplicate of SC-202601-0002" }
```

The reason is stored on the audit record.

**Response `200`** — `{ "message": "...deleted successfully", "ticket": { ... } }`

Soft-deleted items disappear from every read path: detail `GET` (`404`),
project boards, the support board, search, reports, credit queries and project
ticket counts.

### `POST /api/tickets/:id/restore`
### `POST /api/support-tickets/:id/restore`

Undoes a soft delete. **Manager-only** (`CEO`, `TECH_LEAD`, `PM`, `ADMIN`);
others get `403`.

**Body** (optional) — `{ "reason": "deleted by mistake" }`

| Status | Meaning |
|---|---|
| `200` | Restored. Returns the ticket with `deleted_at: null`. |
| `409` | The ticket exists but is not deleted (returns it unchanged). |
| `404` | No such ticket. |

The support variant also returns `linked_ticket_active`, because the dev ticket
it points at may have been deleted while it was gone:

| Value | Meaning |
|---|---|
| `null` | No linked dev ticket |
| `true` | Linked ticket exists and is live |
| `false` | Linked ticket was deleted — the link is dangling |

Restores are audited as action `RESTORE`.

---

## 5. Validation

All mutation routes for tickets, support tickets and credits validate input.
Validation is deliberately lenient: it asserts required fields, formats and
enum membership, and **ignores unknown keys** so existing payloads keep working.

**Error `400`**

```json
{
  "error": "Validation failed",
  "details": [
    { "field": "project_id", "message": "project_id is required and must be a UUID" }
  ]
}
```

`details` is always an array and is safe to render field-by-field.

---

## 6. Credit evaluations

### `POST /api/credits/evaluation`

Unchanged shape, two new behaviours:

- **Monthly lock** — if the evaluation has `locked_at` set, a non-`ADMIN` caller
  gets `403`:
  `{ "error": "This evaluation is locked. Only an admin can adjust it." }`
- **Column whitelist** — only known evaluation columns are written. Unknown keys
  are silently dropped rather than reaching SQL.

Create and update are both audited with before/after values.

---

## 7. Audit log

Every critical action writes to `audit_logs`: actor, IP, user agent, entity,
before/after values and an optional reason.

Audited: `DELETE`, `STATUS_CHANGE`, `BLOCK`, `UNBLOCK`, `CONVERT`, `LINK`,
and credit `CREATE`/`UPDATE`.

Audit writes never fail the user's action — a logging error is recorded to the
console only.

### `GET /api/audit-logs`

**Manager-only** (`CEO`, `TECH_LEAD`, `PM`, `ADMIN`) — records contain IP
addresses and before/after credit values, so this is deliberately not
self-service. Non-managers get `403`.

**Query params** — all optional, all combinable

| Param | Notes |
|---|---|
| `entity_type` | `TICKET`, `SUPPORT_TICKET`, `CREDIT_EVALUATION` |
| `entity_id` | uuid |
| `user_id` | uuid of the actor |
| `action` | `CREATE`, `UPDATE`, `DELETE`, `STATUS_CHANGE`, `BLOCK`, `UNBLOCK`, `CONVERT`, `LINK`, `LOCK`, `RESTORE` |
| `from`, `to` | ISO timestamps |
| `limit` | default `50`, **clamped to `200`** |
| `offset` | default `0` |

An unrecognised `entity_type` or `action` returns `400` rather than silently
returning nothing.

**Response `200`**

```json
{
  "total": 128, "limit": 50, "offset": 0, "has_more": true,
  "logs": [
    { "action": "DELETE", "entity_type": "TICKET", "entity_id": "...",
      "user_name": "Waikeat", "user_email": "...", "reason": "duplicate",
      "before_data": {}, "after_data": null,
      "ip_address": "::1", "created_at": "..." }
  ]
}
```

### `GET /api/audit-logs/:entityType/:entityId`

Convenience view: the full trail for one record, newest first (max 100).
Same role restriction.

---

## Enum reference

Source of truth is `constants/index.js`, which mirrors the live PostgreSQL
enums. Note `schema.sql` is **stale** — do not generate types from it.

| Enum | Values |
|---|---|
| `user_role` | `CEO`, `TECH_LEAD`, `PM`, `QA`, `DEV`, `FINANCE`, `ADMIN` |
| `ticket_status` | `BACKLOG`, `TECH_DESIGN`, `READY_FOR_DEV`, `IN_PROGRESS`, `CODE_REVIEW`, `QA`, `READY_TO_DEPLOY`, `DONE` |
| `ticket_type` | `FEATURE`, `BUG`, `CHANGE_REQUEST` |
| `support_ticket_status` | `NEW`, `DOING`, `WAITING_FOR_CLIENT`, `TESTING`, `PENDING_DEPLOYMENT`, `COMPLETED`, `CLOSED`, `CANCELLED` |
| `support_priority` | `P0`, `P1`, `P2`, `P3` |
| `support_request_type` | `BUG`, `AMENDMENT`, `CHANGE_REQUEST`, `FEATURE`, `QUESTION`, `DATA_ISSUE` |
| `credit_status` | `DRAFT`, `SUBMITTED`, `APPROVED`, `ADJUSTED`, `REJECTED` |

---

## Suggested frontend work

1. **My Work screen** — the highest-value addition. One call, render the six
   buckets; branch detail navigation on `work_type`.
2. **Block / unblock control** on both ticket detail views, with a required
   reason prompt. Surface `blocked_reason` as a banner.
3. **"Convert to dev task"** action on support tickets — needs a target project
   picker. Hide or disable it once `linked_ticket_id` is set, and link through
   to the dev ticket instead.
4. **Delete confirmation** — add an optional reason field, and soften the copy:
   deletion is now recoverable, not permanent.
5. **Validation errors** — render `details[]` against the matching form fields
   rather than showing a generic failure toast.
6. **Restore action** — expose "undo delete" to managers, and show a warning
   when a restored support ticket reports `linked_ticket_active: false`.
7. **Audit trail view** — a history panel on ticket/credit detail via
   `GET /api/audit-logs/:entityType/:entityId`, visible to managers only.

---

## Deployment

Run migrations **in this order**, then deploy the code:

```bash
node migrate_tier1.js            # validation / blockers / audit  (first release)
node migrate_sla_v2.js           # business-hours SLA             (npm run db:migrate:sla)
node migrate_tier1_ownership.js  # owner_user_id + completion evidence
```

All three are additive and idempotent, safe to re-run. Rollback is dropping the
added columns and tables.

Code deployed *ahead* of the last two migrations still works — My Work and the
support endpoints degrade rather than fail — but SLA deadlines will not be
computed until `migrate_sla_v2` has run, so run them first.

### SLA operations

Breach detection is a cron job, not an in-process timer:

```bash
*/10 * * * * cd /path/to/backend && /usr/bin/node jobs/slaBreachCheck.js >> logs/sla.log 2>&1
```

Alerts fire once at ≥80% and once on breach, de-duplicated through `audit_logs`
(`SLA_WARNING` / `SLA_BREACH`). Delivery is a single seam: set `SLA_ALERT_WEBHOOK`
in `.env`, or replace `notify()` in that file with an Xchievers WhatsApp call.
Without it the job logs what it *would* have sent. Dry run with
`npm run sla:check:dry`.

> **Holiday calendar is incomplete by design.** `data/holidays.js` seeds only
> fixed-date Malaysian holidays. The lunar and Islamic holidays move annually and
> were deliberately not guessed — a wrong holiday date silently corrupts every
> deadline spanning it. Until they are filled in from the JPM gazette those days
> count as normal working days. The migration prints exactly which are missing.

### Changed columns

| Table | Added |
|---|---|
| `support_tickets` | `first_response_due_at`, `resolution_due_at`, `sla_paused_total_minutes` |
| `comments` | `is_internal` — **defaults `true`**; a comment must be explicitly marked public to be customer-visible, and only a public one stamps `first_response_at` |
| `tickets` | `owner_user_id`, `completion_explanation`, `pull_request_url`, `test_evidence` |
| new tables | `public_holidays`, `sla_targets`, `sla_pauses` |

`tickets.assigned_to_user_id` is **deprecated**. `owner_user_id` is authoritative;
writes keep both in sync so existing clients keep working. Do not add new reads
of `assigned_to_user_id` — it is slated for removal once nothing references it.

**`JWT_SECRET` is now mandatory.** The application refuses to start if it is
unset, or if it is still the old hardcoded `super_secret_key_change_me` value.
Copy `.env.example` to `.env` and fill it in (local), or set real environment
variables (production). Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rotating the secret **invalidates every existing token**, so all users are
signed out and must log in again. Deploy at a quiet time.
