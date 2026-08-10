# AI Workflow Integration API — Design

Phase 1 design for letting an external AI workflow file and track tickets in
CompanySys. Written before implementation, per §33 of the platform plan.

> **Scope note.** The original plan specified six documents covering
> conversations, a message orchestrator and an AI provider interface. Those
> components no longer exist: WhatsApp, the AI knowledge base and all customer
> conversation happen in a separate AI workflow system. CompanySys remains the
> **internal** ticket system of record and exposes an API for that workflow.
> `conversation-state-machine.md` and `message-orchestrator.md` are therefore
> not written — there is nothing for them to describe.

---

## 1. What this is

```
Customer (client staff)  ──WhatsApp──▶  AI Workflow System
                                             │  owns: comms, knowledge, prompts,
                                             │        AI replies, customer identity
                                             ▼
                                    Integration API  (this document)
                                             │
                                             ▼
                                        CompanySys
                                    owns: tickets, SLA, assignment,
                                          internal workflow, audit
                                             │
                                     status change webhook
                                             │
                                             ▼
                                       AI Workflow System
                                    (tells the customer)
```

CompanySys never speaks to a customer. The AI workflow never manages internal
work. The API is the only seam.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Conversations / messages stored here? | **No.** Owned by the AI workflow. |
| Status readback | **Yes**, via outbound webhook on change |
| AI-supplied priority | **Suggestion only** — PM confirms during triage |
| `supporting_projects` | **Retired.** Support tickets link straight to `projects`. |
| Customer identity | Company is modelled; individual reporter stored as text |

### Why the reporter is not a table

The AI workflow already owns customer identity. A `customers` table here would
be a second directory to keep in sync for no internal benefit — at ~30–50 client
staff, nobody will query "tickets by this person". `company_id` is modelled
properly because billing, SLA and reporting all key off it. Promote the reporter
to a table only if a real need appears.

---

## 3. Database changes

### 3.1 New: `companies`

The client company. Also the fix for `projects.client_name` being free text,
which caused 20 project rows for 4 real projects and would have split per-client
hours five ways.

```sql
CREATE TABLE companies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(255) NOT NULL,
  account_code  VARCHAR(50) UNIQUE,          -- stable key the AI workflow sends
  status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  support_level VARCHAR(20),                 -- drives SLA policy later
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

ALTER TABLE projects ADD COLUMN company_id UUID REFERENCES companies(id);
```

`account_code` is what the workflow sends (`"ONEHAIR"`), so it never needs to
know our UUIDs.

### 3.2 Retire `supporting_projects`

`support_tickets.project_id` already exists as an unused FK to `projects`.
Both `supporting_projects` rows are test data.

1. Backfill `project_id` from `supporting_project_id` where resolvable
2. Stop writing `supporting_project_id`
3. Drop the column and table in a **later** release, once nothing reads it

Dropping in the same release that stops writing it is how you take an outage.

### 3.3 `support_tickets` additions

```sql
external_ref            VARCHAR(128)  -- the workflow's own id, for correlation
source                  VARCHAR(20) NOT NULL DEFAULT 'INTERNAL'  -- INTERNAL | AI_WORKFLOW
company_id              UUID REFERENCES companies(id)
reported_by_name        VARCHAR(255)
reported_by_contact     VARCHAR(100)
suggested_priority      support_priority   -- what the AI proposed
ai_summary              TEXT
ai_preliminary_diagnosis TEXT
cancellation_requested_at   TIMESTAMPTZ
cancellation_reason         TEXT
```

`priority` stays the authoritative field a PM sets. `suggested_priority` records
what the AI proposed, so you can later measure how good its triage is — which is
the evidence you would need before ever trusting it automatically.

### 3.4 New: `api_keys`

```sql
CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  key_hash    VARCHAR(255) NOT NULL UNIQUE,   -- bcrypt; plaintext shown once
  key_prefix  VARCHAR(12) NOT NULL,           -- for identification in logs
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

Never log or store the plaintext. `key_prefix` lets you identify a key in audit
rows without holding the secret.

### 3.5 New: `idempotency_keys`

```sql
CREATE TABLE idempotency_keys (
  key           VARCHAR(128) PRIMARY KEY,
  api_key_id    UUID REFERENCES api_keys(id),
  endpoint      VARCHAR(100) NOT NULL,
  response_body JSONB NOT NULL,
  ticket_id     UUID REFERENCES support_tickets(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

### 3.6 New: `webhook_deliveries`

```sql
CREATE TABLE webhook_deliveries (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event         VARCHAR(50) NOT NULL,
  ticket_id     UUID REFERENCES support_tickets(id),
  payload       JSONB NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING|SENT|FAILED|DEAD
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);
```

A durable outbox, not fire-and-forget. If the workflow is down when a ticket
resolves, the customer must still get told when it comes back.

---

## 4. API surface

Namespaced at `/api/integration/v1/` and kept **separate from the UI's `/api/*`
routes**, which serve the React app and must stay free to change. This one is a
contract with an external system.

Auth: `Authorization: Bearer <api_key>`. No user JWT.

### `POST /tickets` — submit
Header: `Idempotency-Key: <uuid>` (required)

```json
{
  "external_ref": "wf_8821",
  "company_code": "ONEHAIR",
  "project_code": "IBEAUTY_POS",
  "request_type": "BUG",
  "suggested_priority": "P2",
  "title": "Headspa service commission not calculated",
  "description": "...",
  "steps_to_reproduce": "...",
  "reported_by_name": "Ms Tan",
  "reported_by_contact": "+60123456789",
  "ai_summary": "...",
  "ai_preliminary_diagnosis": "Possible commission rule mismatch",
  "first_responded_at": "2026-08-10T09:12:00+08:00",
  "attachments": [{ "name": "screenshot.png", "url": "..." }]
}
```

`first_responded_at` matters: the AI already replied to the customer before this
ticket existed. Without it every AI-filed ticket looks like an instant
first-response SLA breach.

Returns `201` with `ticket_key`, or `200` and the original ticket on replay.

### `PATCH /tickets/:ticket_key` — update
Whitelisted: `description`, `steps_to_reproduce`, `suggested_priority`,
`ai_summary`, `ai_preliminary_diagnosis`, `attachments`, `reported_by_*`.

Rejected: `status`, `priority`, `assigned_dev_id`, any SLA field, `resolution`.
**The workflow proposes; CompanySys decides.**

### `POST /tickets/:ticket_key/cancel`
- `NEW` / `TRIAGING` → cancels immediately
- anything later → records `cancellation_requested_at` and flags for a human

A customer saying "never mind" must not erase two days of a developer's work.

### `POST /tickets/:ticket_key/notes`
Adds a comment. Always `is_internal = true` — nothing from this API is
customer-visible, because CompanySys never talks to customers.

### `GET /tickets/:ticket_key` — readback
### `GET /tickets?since=<iso>` — reconciliation poll
Safety net for missed webhooks. Cheap to build, and the thing you will want at
3am when deliveries have been failing silently.

### `GET /tickets?search=&company_code=&status=` — dedup lookup
So the workflow can check before filing the same bug a fifth time.

---

## 5. Outbound webhook

Fires on: status change, assignment, resolution, cancellation confirmed.

```json
{
  "event": "ticket.status_changed",
  "ticket_key": "SC-202608-0042",
  "external_ref": "wf_8821",
  "from": "DOING",
  "to": "COMPLETED",
  "occurred_at": "2026-08-10T14:02:00+08:00"
}
```

- Signed with HMAC-SHA256 over the raw body (`X-CompanySys-Signature`)
- Retries with exponential backoff, then `DEAD` after N attempts
- Delivery attempts recorded; dead letters visible in the dashboard

The receiver must treat deliveries as at-least-once and key off `event` +
`ticket_key` + `occurred_at`.

---

## 6. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | `ticket_key` generation is racy (`getLatestKey` + 1) — concurrent creates collide | **High** | Postgres sequence, or unique constraint + retry. Existing bug; a machine caller will actually hit it. |
| 2 | Webhook fails silently → customer never told | **High** | Durable outbox + retries + dead-letter visible in UI + `?since=` reconciliation |
| 3 | Retry storm creates duplicate tickets | **High** | Idempotency keys, unique-constrained |
| 4 | AI floods tickets on a bad day | Medium | Rate limit per API key; dedup lookup endpoint |
| 5 | API key leaked | Medium | Hashed at rest, scoped, revocable, `last_used_at` monitoring |
| 6 | Cancel destroys in-progress work | Medium | Status-gated cancellation (§4) |
| 7 | SLA mis-measured on AI-filed tickets | Medium | Accept `first_responded_at` |
| 8 | Dropping `supporting_projects` too early | Low | Two-release retirement |

---

## 7. Build order

1. `companies` + `projects.company_id` + backfill; retire `supporting_projects` writes
2. Fix the `ticket_key` race (prerequisite — it becomes reachable under machine load)
3. `api_keys` + bearer auth middleware + `actor_type: SERVICE` in audit
4. `POST /tickets` + idempotency, then `PATCH`, `cancel`, `notes`
5. Readback + `?since=` + search
6. Outbound webhook: outbox table, sender, retry, dead-letter
7. UI: source badge on AI-filed tickets, suggested-vs-actual priority, cancellation-request queue, dead-letter panel
8. API reference doc for the workflow team

Steps 1–5 deliver a working inbound integration. Step 6 closes the loop with the
customer. Step 7 is what makes it usable by your PM.

Every step: tests, transactional writes, idempotent handlers, no behaviour change
to the existing human-facing endpoints.
