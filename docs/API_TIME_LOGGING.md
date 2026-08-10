# Time Logging API

Billing-grade time capture against both kanban and support work, with approval,
period locking and per-client reporting.

All endpoints require `Authorization: Bearer <jwt>`.

---

## Model

One entry = one person, one work item, one day.

| Field | Notes |
|---|---|
| `ticket_id` / `support_ticket_id` | exactly one, enforced by a CHECK constraint |
| `user_id` | whose hours these are |
| `minutes` | **exact minutes as worked**, 1–1440. Never pre-rounded |
| `logged_for_date` | the day the work happened, *not* the day it was typed |
| `is_billable` | defaults `true` |
| `status` | `DRAFT → SUBMITTED → APPROVED → LOCKED` |
| `corrects_entry_id` | set when this entry corrects an approved one |

### Three rules that matter

**Minutes are stored exactly; rounding happens at report time.** Rounding on
write destroys the source number, and you can never re-derive it under a
different agreement. The rounding mode is a report parameter.

**`logged_for_date` is separate from `created_at`.** People log Friday's work on
Monday. Without the split, every retrospective entry lands in the wrong billing
period.

**`APPROVED` and `LOCKED` entries are immutable.** Editing one would make an
invoice you have already sent stop matching the data behind it. Changes arrive
as a correcting entry via `POST /:id/correct`, which creates a new entry and
marks the original non-billable — the original row is never destroyed.

---

## Endpoints

### `POST /api/time-logs`
```json
{ "ticket_id": "uuid", "minutes": 95, "logged_for_date": "2026-08-03",
  "is_billable": true, "note": "pairing on the auth flow" }
```
Pass `support_ticket_id` instead for support work. Pass `user_id` to log on
someone else's behalf — **managers only**, otherwise `403`.

### `GET /api/time-logs`
Filters: `userId`, `projectId`, `clientName`, `from`, `to`, `status`,
`ticketId`, `supportTicketId`, `billableOnly`. Non-managers only ever see their
own entries, whatever `userId` says.

### `PATCH /api/time-logs/:id`
Edits `minutes`, `logged_for_date`, `is_billable`, `note`. `409` once approved.

### `POST /api/time-logs/:id/transition`
```json
{ "status": "SUBMITTED" | "APPROVED" | "DRAFT", "reason": "optional" }
```
Legal transitions come from `TIME_LOG_TRANSITIONS` in `constants/index.js`.
`DRAFT` from `SUBMITTED` is a rejection; `DRAFT` from `APPROVED` is a reopen and
needs an admin.

> **Separation of duties.** A manager cannot approve their own time, even though
> they can approve everyone else's. Another manager reviews theirs. Without this
> the approval step certifies nothing on the one person best placed to inflate it.

### `POST /api/time-logs/:id/correct`
```json
{ "minutes": 60, "note": "logged against the wrong ticket" }
```
Managers only. Creates a new entry carrying the corrected total, linked by
`corrects_entry_id`, and flips the original to non-billable.

### `DELETE /api/time-logs/:id`
Soft delete. `409` once approved.

### `GET /api/time-logs/period/status?from=&to=`
What would block a lock — every `DRAFT`/`SUBMITTED` entry in the window.

### `POST /api/time-logs/period/lock`
```json
{ "from": "2026-08-01", "to": "2026-08-31", "force": false }
```
`ADMIN`/`CEO` only. Refuses with `409` if unapproved entries exist, since
locking around them quietly bills a partial period. `force: true` locks only the
approved entries and records the override in the audit log.

---

## Reports

### `GET /api/reports/time`

| Param | Values |
|---|---|
| `from`, `to` | required |
| `rounding` | `EXACT`, `NEAREST_15`, `UP_15` (default), `UP_PER_DAY_15` |
| `groupBy` | `client` (default), `project`, `user`, `work_type` |
| `status` | defaults to `APPROVED` + `LOCKED` only |

Managers only. Every group reports both `exact_hours` and `billable_hours` plus
the `rounding_uplift_minutes` between them, so the effect of the rounding rule is
always visible rather than baked in.

**Rounding modes**

| Mode | Five 5-minute entries in one day |
|---|---|
| `EXACT` | 25 min |
| `NEAREST_15` | 0 min (each rounds to zero) |
| `UP_15` | 75 min — each entry rounds up separately |
| `UP_PER_DAY_15` | 30 min — the day is summed, then rounded once |

`UP_15` is the common agency default and the most generous to you.
`UP_PER_DAY_15` is materially fairer to the client and the one to pick if
anyone ever audits an invoice.

**`warnings` block** — reports `unattributed_hours` (billable time that cannot
reach a client) and `pending_approval_hours`. Unattributed time is surfaced
rather than dropped: it is revenue you are not invoicing.

### `GET /api/reports/time/estimate-vs-actual?from=&to=`
Actual logged hours per kanban ticket. `tickets` has no estimate column yet, so
this is actuals only until `estimated_minutes` is added.

---

## Deployment

```bash
node migrate_time_logs.js
```

Additive and idempotent. Adds `supporting_projects.project_id`, the
`time_log_status` enum, `work_time_logs`, and four partial indexes.

### Two data problems it will report

**`supporting_projects` rows with no `project_id`.** Support tickets reach a
client only through this link. Until it is set, support time is logged fine but
lands in `unattributed_hours` and appears on no client's invoice. Both current
rows (`Debug Project`, `aaaaaaa`) are test data and should be replaced with real
supporting projects pointing at real projects.

**Duplicate rows in `projects`.** There are 20 rows but only 4 distinct
name/client pairs — each duplicated five times, almost certainly
`seed_demo_data.js` output. If any of it is real, per-client hours split across
the duplicates and **under-bill the client**. Merge before invoicing from this
data.
