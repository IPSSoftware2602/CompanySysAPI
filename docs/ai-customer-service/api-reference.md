# CompanySys Integration API — Reference

For the team building the AI workflow system. This documents what is
implemented, not what is planned.

**Base URL** `https://kanban-api.ips.com.my/api/integration/v1`

---

## 1. Model in one paragraph

The workflow owns the customer: WhatsApp, the knowledge base, prompts, replies,
identity. CompanySys owns the internal work: tickets, SLA, assignment, audit. It
never speaks to a customer. This API is the only seam.

The rule everything follows: **the workflow proposes, CompanySys decides.** You
can suggest a priority; you cannot set one. You can request a cancellation; you
cannot always cause one.

---

## 2. Authentication

```http
Authorization: Bearer csk_a1b2c3d4_<48 hex chars>
```

Keys are issued with `npm run apikey:create` and shown once. Scopes are
`tickets:read` and `tickets:write`; a key holds only what it was granted.

Every auth failure — malformed, unknown, revoked, wrong secret — returns the
same `401` with the same body. This is deliberate: differentiated errors would
let the endpoint be used to test whether a key exists.

```json
{ "error": "Invalid or revoked API key" }
```

Writes are rate limited to **60/minute per key**. Exceeding it returns `429`.

---

## 3. Filing a ticket

### `POST /tickets`

**`Idempotency-Key` is required.** You will time out and retry; without it, one
customer complaint becomes three tickets. Use a stable UUID per customer issue —
the same value on every retry of that issue.

```http
POST /api/integration/v1/tickets
Authorization: Bearer csk_...
Idempotency-Key: 5f2a...-uuid
Content-Type: application/json
```

```json
{
  "external_ref": "wf_8821",
  "company_code": "ONEHAIR",
  "project_code": "iBeauty POS",
  "request_type": "BUG",
  "suggested_priority": "P2",
  "title": "Headspa service commission not calculated",
  "description": "Commission shows RM0 on invoice INV-18382",
  "steps_to_reproduce": "1. Open invoice INV-18382 …",
  "reported_by_name": "Ms Tan",
  "reported_by_contact": "+60123456789",
  "ai_summary": "Commission rule mismatch suspected",
  "ai_preliminary_diagnosis": "Headspa item may sit outside the commission group",
  "first_responded_at": "2026-08-10T09:12:00+08:00",
  "attachments": [{ "name": "screenshot.png", "url": "https://…" }]
}
```

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | |
| `request_type` | ✅ | `BUG`, `AMENDMENT`, `CHANGE_REQUEST`, `FEATURE`, `QUESTION`, `DATA_ISSUE` |
| `suggested_priority` | | `P0`–`P3`. **A suggestion.** A PM confirms it during triage. Defaults to `P3` if omitted — an unreviewed ticket should not page anyone. |
| `company_code` | | `account_code` or company name |
| `project_code` | | project name |
| `external_ref` | | your id, echoed back on every response and webhook |
| `first_responded_at` | | **Send this.** See below. |
| `attachments` | | `[{ name, url }]`. The files are **downloaded and re-hosted** by CompanySys, so your link may expire afterwards. See below. |

> **Attachments are copied, not linked.** CompanySys fetches each URL at
> creation and serves the file from its own storage, because WhatsApp media
> links expire and a ticket opened three weeks later would show a dead image.
>
> Constraints, all of which produce a `warnings` entry rather than a failure:
> at most 10 attachments; 10MB each; `http`/`https` only; no redirects; the
> content type must be one of pdf, png, jpg, gif, webp, xlsx, xls, docx, doc,
> pptx, csv, txt, log, zip. Anything that cannot be stored keeps your original
> URL and is marked `"unverified": true`.

> **`first_responded_at` matters.** You already replied to the customer on
> WhatsApp before this ticket existed. Without that timestamp, CompanySys starts
> the first-response SLA clock at ticket creation and every AI-filed ticket looks
> like an instant breach.

**`201` on success**, `200` with `"replayed": true` on a retry:

```json
{
  "ticket_key": "SC-202608-0042",
  "external_ref": "wf_8821",
  "status": "NEW",
  "priority": "P2",
  "suggested_priority": "P2",
  "request_type": "BUG",
  "title": "Headspa service commission not calculated",
  "company": "One Hair",
  "project": "iBeauty POS",
  "created_at": "2026-08-10T09:15:00.000Z",
  "updated_at": "2026-08-10T09:15:00.000Z",
  "tech_lead": "Waikeat",
  "resolved_at": null,
  "closed_at": null,
  "cancellation_requested_at": null
}
```

A `warnings` array appears when something could not be resolved:

```json
"warnings": ["Unknown company_code \"NOPE\" — attributed via project \"iBeauty POS\" instead"]
```

Take warnings seriously — `Ticket has no company` means time logged against it
reaches no invoice.

**Errors**

| Code | Meaning |
|---|---|
| `400` | Missing `Idempotency-Key`, or validation failed (`details` lists why) |
| `409` | A request with this key is still in flight — wait, do not re-send |
| `422` | This key was already used for a different endpoint |
| `429` | Rate limited |

Validation runs *before* the key is claimed, so a rejected request does not burn
the key — fix the payload and re-send with the same one.

---

## 4. Updating

### `PATCH /tickets/{ticket_key}`

Accepted: `description`, `steps_to_reproduce`, `suggested_priority`,
`ai_summary`, `ai_preliminary_diagnosis`, `reported_by_name`,
`reported_by_contact`, `external_ref`.

Rejected with `403` and the offending field names: `status`, `priority`,
`assigned_dev_id`, `assigned_pm_id`, and every SLA field. These belong to
CompanySys — accepting them would let an external system mark its own ticket
resolved.

`409` if the ticket is already `COMPLETED`, `CLOSED` or `CANCELLED`.

---

## 5. Cancelling

### `POST /tickets/{ticket_key}/cancel`

```json
{ "reason": "Customer says it resolved itself" }
```

Behaviour depends on whether anyone has invested work:

| Ticket status | Result |
|---|---|
| `NEW` | Cancelled immediately — `"cancelled": true` |
| Anything later | **Request recorded** — `"cancelled": false`, flagged for a human |

```json
{
  "ticket_key": "SC-202608-0042",
  "status": "DOING",
  "cancelled": false,
  "cancellation_requested_at": "2026-08-10T11:02:00.000Z",
  "message": "Work is already underway — cancellation requested and flagged for a human to confirm."
}
```

A customer saying "never mind" must not silently erase two days of a
developer's work. When a human resolves it you receive `ticket.cancelled` or
`ticket.status_changed` with `cancellation_declined: true` — so tell the
customer only once you get that event, not when you send this request.

---

## 6. Notes

### `POST /tickets/{ticket_key}/notes`

```json
{ "content": "Customer sent a second screenshot showing the same total" }
```

**Always internal.** Nothing sent here is ever shown to a customer, because
CompanySys has no customer-facing surface. Use it to give the developer context
you gathered in conversation.

---

## 6b. Project library

### `GET /projects`

The list of projects to match a customer's message against. Read scope.

```json
{
  "projects": [
    {
      "project_code": "iBeauty POS",
      "name": "iBeauty POS",
      "status": "ACTIVE",
      "company": "One Hair",
      "company_code": "ONEHAIR",
      "tech_lead": "Waikeat",
      "aliases": ["iBeauty POS", "One Hair"]
    }
  ],
  "count": 1,
  "generated_at": "2026-08-27T11:38:54.154Z"
}
```

`project_code` is the value `POST /tickets` resolves — send it back verbatim.
`aliases` are the strings a customer is likely to use for the same project.

`tech_lead` is display only. Assignment stays with CompanySys.

---

## 7. Reading

### `GET /tickets/{ticket_key}`
Returns the same shape as `POST`. `404` if unknown.

### `GET /tickets`

| Param | Purpose |
|---|---|
| `since` | ISO 8601. Everything updated at or after this. **Reconciliation.** |
| `search` | Substring of title or description. **Dedup before filing.** |
| `company_code`, `status`, `external_ref` | Filters |
| `limit` | Default 50, max 200 |

```json
{
  "count": 50,
  "limit": 50,
  "has_more": true,
  "next_since": "2026-08-10T09:15:00.000Z",
  "tickets": [ … ]
}
```

**Poll loop:** start with your last `next_since`, keep fetching while
`has_more` is true.

> `since` is **inclusive**. The boundary ticket reappears on the next poll.
> That is deliberate — an exclusive filter could skip a ticket written in the
> same millisecond. Deduplicate by `ticket_key`.

Use `search` before filing to avoid a fifth ticket for the same bug.

---

## 8. Webhooks

CompanySys POSTs to your endpoint whenever an AI-filed ticket changes. Human-filed
tickets generate no events — nobody is waiting on WhatsApp for those.

```http
POST <your endpoint>
Content-Type: application/json
X-CompanySys-Event: ticket.status_changed
X-CompanySys-Delivery: 9c1e…uuid
X-CompanySys-Signature: sha256=<hex>
```

```json
{
  "event": "ticket.status_changed",
  "ticket_key": "SC-202608-0042",
  "external_ref": "wf_8821",
  "status": "COMPLETED",
  "priority": "P2",
  "from": "TESTING",
  "to": "COMPLETED",
  "occurred_at": "2026-08-10T14:02:00.000Z"
}
```

**Events**

| Event | When |
|---|---|
| `ticket.status_changed` | Any status transition. Also carries `cancellation_declined` when a human keeps working. |
| `ticket.assigned` | A developer picked it up or was unassigned |
| `ticket.cancelled` | Cancelled — by you directly, or approved by a human |
| `ticket.cancellation_requested` | Your request is pending a human decision |

### Verifying the signature

HMAC-SHA256 over the **raw request body** with the shared secret. Verify against
the bytes received — re-serialising the JSON reorders keys and the signature
will never match.

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET)
    .update(rawBody, 'utf8').digest('hex');
crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedHeader));
```

### Delivery semantics

**At-least-once.** Deduplicate on `X-CompanySys-Delivery`.

Respond `2xx` to acknowledge. Anything else — or a connection failure — is
retried at 1, 5, 15, 30 and 60 minutes. After six attempts the delivery is
marked dead and surfaced on the CompanySys dashboard for a human to retry.

Acknowledge fast and process asynchronously; a slow endpoint looks like a
failure and earns a retry.

**Because delivery can fail, do not rely on webhooks alone.** Poll
`GET /tickets?since=` periodically. That is what catches you up after an outage
without a customer being forgotten.

---

## 9. Reference

**Ticket statuses** `NEW`, `DOING`, `WAITING_FOR_CLIENT`, `TESTING`,
`PENDING_DEPLOYMENT`, `COMPLETED`, `CLOSED`, `CANCELLED`

`CANCELLED` is not `CLOSED` — it is work that never happened.

**Request types** `BUG`, `AMENDMENT`, `CHANGE_REQUEST`, `FEATURE`, `QUESTION`,
`DATA_ISSUE`

**Priorities** `P0` (1h first response / 8h resolution) · `P1` (4h/24h) ·
`P2` (8h/40h) · `P3` (16h/80h)

Those are **working hours** on the Malaysian business calendar — Mon–Fri
09:00–18:15, Sat 09:00–13:00, Sunday and public holidays excluded. P1's 24h is
about two and a half working days, not one calendar day.

---

## 10. Integration checklist

- [ ] Stable `Idempotency-Key` per customer issue, reused across retries
- [ ] `external_ref` set so you can correlate without storing our keys
- [ ] `first_responded_at` sent, or every ticket looks like an SLA breach
- [ ] `warnings` in responses logged and acted on
- [ ] Webhook signature verified against the raw body
- [ ] Webhook deliveries deduplicated on `X-CompanySys-Delivery`
- [ ] Webhook acknowledged fast, processed async
- [ ] `GET /tickets?since=` polled as a backstop
- [ ] `search` checked before filing, to avoid duplicates
- [ ] Customer told a ticket is cancelled only after the **event**, not on request
